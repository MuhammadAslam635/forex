import { Op } from "sequelize";
import ExchangeManager from "@b/utils/exchange";
import { sendMessageToRoute } from "@b/handler/Websocket";
import { createError } from "@b/utils/error";
import { processRewards } from "@b/utils/affiliate";
import { getUserById } from "@b/api/user/profile/index.get";
import { sendSpotWalletDepositConfirmationEmail } from "@b/utils/emails";
import { models } from "@b/db";
import { updateTransaction } from "../../utils";
import { handleNotification } from "@b/utils/notifications";
import { CacheManager } from "@b/utils/cache";
import {
  mapToXtNetwork,
  parseMetadataAndMapChainToXt,
  parseTransactionMetadata,
} from "./utils";

const path = "/api/finance/deposit/spot";
export const metadata = {};
export const spotVerificationIntervals: Map<string, NodeJS.Timeout> = new Map();

export default async (data: Handler, message) => {
  const { user } = data;

  if (!user?.id) throw createError(401, "Unauthorized");
  if (typeof message === "string") {
    message = JSON.parse(message);
  }

  const { trx } = message.payload;

  const transaction = await models.transaction.findOne({
    where: { referenceId: trx, userId: user.id, type: "DEPOSIT" },
  });

  if (transaction) {
    sendMessage(message.payload, {
      status: 200,
      message: "Transaction hash already exists",
    });
    return;
  }

  startSpotVerificationSchedule(transaction.id, user.id, trx);
};

const sendMessage = (payload, data) => {
  try {
    sendMessageToRoute(path, payload, {
      stream: "verification",
      data: data,
    });
  } catch (error) {
    console.error(`Failed to send message: ${error}`);
  }
};

export function startSpotVerificationSchedule(
  transactionId: string,
  userId: string,
  trx: string
) {
  const payload = {
    trx,
  };
  // Clear any existing interval for this transaction (if any)
  const existingInterval = spotVerificationIntervals.get(transactionId);
  if (existingInterval) {
    clearInterval(existingInterval);
  }

  // Schedule the verifyTransaction function to run every 30 seconds
  const interval = setInterval(async () => {
    try {
      await verifyTransaction(userId, trx, payload);
    } catch (error) {
      console.error(`Error verifying transaction: ${error.message}`);
      stopVerificationSchedule(transactionId);
    }
  }, 15000) as unknown as NodeJS.Timeout;

  // Store the interval in the map
  spotVerificationIntervals.set(transactionId, interval);

  // Stop the verification schedule after 30 minutes
  setTimeout(() => {
    stopVerificationSchedule(transactionId);
  }, 1800000); // 30 minutes in milliseconds
}

export function stopVerificationSchedule(transactionId: string) {
  const interval = spotVerificationIntervals.get(transactionId);
  if (interval) {
    clearInterval(interval);
    spotVerificationIntervals.delete(transactionId);
  }
}

export async function verifyTransaction(
  userId: string,
  trx: string,
  payload: any
) {
  const transaction = await getTransactionQuery(userId, trx);

  if (!transaction) {
    throw new Error("Transaction not found");
  }

  const wallet = await models.wallet.findByPk(transaction.walletId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const { metadata, xtChain } = parseMetadataAndMapChainToXt(
    transaction.metadata
  );

  if (transaction.status === "COMPLETED") {
    sendMessage(payload, {
      status: 201,
      message: "Transaction already completed",
      transaction,
      balance: wallet.balance,
      currency: wallet.currency,
      chain: metadata.chain,
      method: "Wallet Transfer",
    });
    stopVerificationSchedule(transaction.id);
    return;
  }

  // Initialize exchange
  const exchange = await ExchangeManager.startExchange();
  if (!exchange) {
    throw new Error("Exchange not found");
  }
  const provider = await ExchangeManager.getProvider();
  if (!provider) {
    throw new Error("Provider not found");
  }

  try {
    await ExchangeManager.testExchangeCredentials(provider);
  } catch (error) {
    console.error(`Error testing exchange credentials: ${error.message}`);
    return;
  }

  let deposits: any[] = [];
  try {
    if (exchange.has["fetchDeposits"]) {
      const params: Record<string, any> = {};

      // If the exchange is xt, pass the chain as `network`
      if (xtChain) {
        params.chain = xtChain;
      }

      deposits = await exchange.fetchDeposits(
        wallet.currency,
        undefined,
        undefined,
        params
      );
      console.log("🚀 ~ deposits:", deposits);
    } else if (exchange.has["fetchTransactions"]) {
      deposits = await exchange.fetchTransactions();
    }
  } catch (error) {
    console.error("Error fetching deposits or transactions:", error);
    return; // Exit the function if we can't fetch deposits
  }

  let deposit;
  if (provider === "binance") {
    deposit = deposits.find((d) => {
      // Parse txid if it's from Binance and contains "Off-chain transfer"
      const parsedTxid = parseBinanceTxid(d.txid);
      return parsedTxid === transaction.referenceId;
    });
  } else {
    // For other providers, use the txid as is
    deposit = deposits.find((d) => d.txid === transaction.referenceId);
  }

  if (!deposit) {
    return;
  }

  if (deposit.status !== "ok") {
    return;
  }

  const amount = deposit.amount;
  const fee = deposit.fee?.cost || 0;

  if (
    ["kucoin", "binance", "okx", "xt"].includes(provider) &&
    wallet.currency !== deposit.currency
  ) {
    sendMessage(payload, {
      status: 400,
      message: "Invalid deposit currency",
    });
    stopVerificationSchedule(transaction.id);
    await deleteTransaction(transaction.id);
    return;
  }

  if (transaction.status === "COMPLETED") {
    sendMessage(payload, {
      status: 201,
      message: "Transaction already completed",
      transaction,
      balance: wallet.balance,
      currency: wallet.currency,
      chain: metadata.chain,
      method: "Wallet Transfer",
    });
    stopVerificationSchedule(transaction.id);
    return;
  }

  const cacheManager = CacheManager.getInstance();
  const settings = await cacheManager.getSettings();
  if (
    settings.has("depositExpiration") &&
    settings.get("depositExpiration") === "true"
  ) {
    const createdAt = deposit.timestamp / 1000;
    const transactionCreatedAt =
      new Date(transaction.createdAt).getTime() / 1000;
    const currentTime = Date.now() / 1000;
    const timeDiff = (currentTime - createdAt) / 60; // Difference in minutes

    if (
      createdAt < transactionCreatedAt - 900 ||
      createdAt > transactionCreatedAt + 900 ||
      timeDiff > 45
    ) {
      sendMessage(payload, {
        status: 400,
        message: "Deposit expired",
      });
      stopVerificationSchedule(transaction.id);
      await updateTransaction(transaction.id, {
        status: "TIMEOUT",
        description: "Deposit expired. Please try again.",
        amount: amount,
      });
      return;
    }
  }

  // Generalized function to parse txid if it includes text like "Off-chain transfer" in different languages
  function parseBinanceTxid(txid: string) {
    // A regex that matches any variations of "Off-chain transfer" in all locales
    const offChainTransferPatterns = [
      /off-?chain transfer\s+(\w+)/i, // English: Off-chain transfer or Offchain transfer
      /transferência\s+off-chain\s+(\w+)/i, // Portuguese: Transferência off-chain
      /transferencia\s+off-chain\s+(\w+)/i, // Spanish: Transferencia off-chain
    ];

    // Try to match the txid against the patterns
    for (const pattern of offChainTransferPatterns) {
      const match = txid.match(pattern);
      if (match && match[1]) {
        return match[1]; // Return the extracted transaction ID part
      }
    }

    // If no pattern matches, return the original txid
    return txid;
  }

  // update the amount and fee of the transaction using the deposit data
  const updatedTransaction = await updateTransaction(transaction.id, {
    status: "COMPLETED",
    description: `Deposit of ${amount} ${wallet.currency} to wallet`,
    amount: amount,
    fee: fee,
  });

  // Update the wallet balance
  const updatedWallet = (await updateSpotWalletBalance(
    userId,
    wallet.currency,
    amount,
    fee,
    "DEPOSIT"
  )) as walletAttributes;

  if (!updatedWallet) {
    sendMessage(payload, {
      status: 500,
      message: "Failed to update wallet balance",
    });
    stopVerificationSchedule(updatedTransaction.id);
    return;
  }

  // Transfer the amount from main to trade account within KuCoin
  if (provider === "kucoin") {
    try {
      // Transferring the amount from main to trade account within KuCoin
      await exchange.transfer(wallet.currency, deposit.amount, "main", "trade");
    } catch (error) {
      console.error(`Transfer failed: ${error.message}`);
    }
  }

  const userData = await getUserById(userId);
  try {
    await sendSpotWalletDepositConfirmationEmail(
      userData,
      updatedTransaction,
      updatedWallet,
      metadata.chain
    );
    await handleNotification({
      userId: userId,
      type: "ACTIVITY",
      title: "Deposit Confirmation",
      message: `Your deposit of ${amount} ${wallet.currency} has been confirmed.`,
    });
  } catch (error) {
    console.error(`Deposit confirmation email failed: ${error.message}`);
  }

  try {
    await processRewards(userData.id, amount, "WELCOME_BONUS", wallet.currency);
  } catch (error) {
    console.error(`Error processing rewards: ${error.message}`);
  }

  sendMessage(payload, {
    status: 200,
    message: "Transaction completed",
    transaction: updatedTransaction,
    balance: updatedWallet.balance,
    currency: updatedWallet.currency,
    chain: metadata.chain,
    method: "Wallet Transfer",
  });
  stopVerificationSchedule(updatedTransaction.id);
}

function normalizeTransactionReference(reference: string) {
  const lowerCaseReference = reference.toLowerCase().trim();

  // Array of possible patterns (we can expand this list for more languages)
  const offChainPatterns = [
    "off-chain transfer",
    "offchain transfer", // sometimes it may be written without hyphen
    "transferencia fuera de cadena", // Spanish
    // Add more language variations here if needed
  ];

  // Check if the reference matches any known off-chain transfer pattern
  for (const pattern of offChainPatterns) {
    if (lowerCaseReference.includes(pattern)) {
      return "off-chain transfer"; // Standardize to a unified identifier
    }
  }

  return reference; // Return the original reference if no pattern matches
}

export async function getTransactionQuery(userId: string, trx: string) {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  const transaction = await models.transaction.findOne({
    where: {
      referenceId: trx,
      userId: userId,
      type: "DEPOSIT",
      createdAt: {
        [Op.gte]: thirtyMinutesAgo,
      },
    },
    include: [
      {
        model: models.wallet,
        as: "wallet",
        attributes: ["id", "currency"],
      },
      {
        model: models.user,
        as: "user",
        attributes: ["firstName", "lastName", "email", "avatar"],
      },
    ],
  });

  if (!transaction) {
    throw new Error("Transaction not found");
  }

  return transaction.get({ plain: true }) as unknown as Transaction;
}

export async function deleteTransaction(id: string) {
  await models.transaction.destroy({
    where: {
      id,
    },
  });
}

export async function updateSpotWalletBalance(
  userId: string,
  currency: string,
  amount: number,
  fee: number,
  type: "DEPOSIT" | "WITHDRAWAL" | "REFUND_WITHDRAWAL"
) {
  const wallet = await models.wallet.findOne({
    where: {
      userId: userId,
      currency: currency,
      type: "SPOT",
    },
  });

  if (!wallet) {
    return new Error("Wallet not found");
  }

  let balance;
  switch (type) {
    case "WITHDRAWAL":
      balance = wallet.balance - (amount + fee);
      break;
    case "DEPOSIT":
      balance = wallet.balance + (amount - fee);
      break;
    case "REFUND_WITHDRAWAL":
      balance = wallet.balance + amount + fee;
      break;
    default:
      break;
  }

  if (balance < 0) {
    throw new Error("Insufficient balance");
  }

  await models.wallet.update(
    {
      balance: balance,
    },
    {
      where: {
        id: wallet.id,
      },
    }
  );

  const updatedWallet = await models.wallet.findByPk(wallet.id);

  if (!updatedWallet) {
    throw new Error("Wallet not found");
  }

  return updatedWallet.get({ plain: true });
}
