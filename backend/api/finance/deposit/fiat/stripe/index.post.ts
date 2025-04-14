// /server/api/deposit/stripe.post.ts
import {
  notFoundMetadataResponse,
  serverErrorResponse,
  unauthorizedResponse,
} from "@b/utils/query";
import { useStripe } from "./utils";
import { models } from "@b/db";

const publicUrl = process.env.NEXT_PUBLIC_SITE_URL;
const isProduction = process.env.NODE_ENV === "production";

export const metadata: OperationObject = {
  summary: "Creates a Stripe payment intent or checkout session",
  description:
    "Initiates a Stripe payment process by creating either a payment intent or a checkout session, based on the request parameters. For mobile (Flutter) applications, returns a checkout session and associated payment intent details; for web applications, returns the session URL and version.",
  operationId: "createStripePayment",
  tags: ["Finance", "Deposit"],
  requestBody: {
    description: "Payment information and application type",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            amount: {
              type: "number",
              description:
                "Payment amount in smallest currency unit (e.g., cents)",
            },
            currency: {
              type: "string",
              description: "Currency code (e.g., USD)",
            },
            intent: {
              type: "boolean",
              description:
                "Flag indicating if the request is from a mobile app",
              nullable: true,
            },
          },
          required: ["amount", "currency"],
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Payment intent or checkout session created successfully. For mobile applications, `sessionid`, `sessionUrl`, `intentId`, and `intentSecret` are returned; for web applications, `version`, `id`, and `url` are provided.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Checkout session ID for web flow",
                nullable: true,
              },
              url: {
                type: "string",
                description: "Checkout session URL for web flow",
                nullable: true,
              },
              // Mobile flow response
              intentId: {
                type: "string",
                description: "Payment intent ID for mobile flow",
              },
              intentSecret: {
                type: "string",
                description: "Client secret for mobile payment intent",
              },
              // Web flow response
              version: {
                type: "string",
                description: "Stripe API version for web flow",
                nullable: true,
              },
            },
          },
        },
      },
    },
    401: unauthorizedResponse,
    404: notFoundMetadataResponse("Stripe"),
    500: serverErrorResponse,
  },
  requiresAuth: true,
};

export default async (data: Handler) => {
  const { user, body } = data;
  if (!user) throw new Error("User not authenticated");

  const { amount, currency, intent } = body;
  const amountCent = amount * 100;

  const gateway = await models.depositGateway.findOne({
    where: { alias: "stripe", status: true },
  });
  if (!gateway) throw new Error("Stripe gateway not found");

  if (!gateway.currencies?.includes(currency)) {
    throw new Error(`Currency ${currency} is not supported by Stripe`);
  }

  const { fixedFee, percentageFee } = gateway;
  const taxAmount = (amount * (percentageFee || 0)) / 100 + (fixedFee || 0);
  const taxAmountCent = taxAmount * 100;

  const stripe = useStripe();

  // Mobile flow: if `intent` is true, create a Checkout session with mobile-specific URLs
  if (intent) {
    const totalAmount = amountCent + taxAmountCent;
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: currency,
              product_data: { name: "Deposit" },
              unit_amount: amountCent,
            },
            quantity: 1,
          },
          {
            price_data: {
              currency: currency,
              product_data: { name: "Tax" },
              unit_amount: taxAmountCent,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        // Force creation of a PaymentIntent as part of the session
        payment_intent_data: {},
        success_url: `${publicUrl}/stripe-app-redirect.html?sessionId={CHECKOUT_SESSION_ID}&type=success`,
        cancel_url: `${publicUrl}/stripe-app-redirect.html?sessionId={CHECKOUT_SESSION_ID}&type=cancel`,
        expand: ["payment_intent"],
      });

      // If Stripe did not return a PaymentIntent in the session, create one manually.
      let paymentIntent;
      if (session.payment_intent) {
        paymentIntent = session.payment_intent as {
          id: string;
          client_secret: string;
        };
      } else {
        // Fallback: create a PaymentIntent separately.
        paymentIntent = await stripe.paymentIntents.create({
          amount: totalAmount,
          currency,
        });
      }

      return {
        id: session.id,
        url: session.url,
        intentId: paymentIntent.id,
        intentSecret: paymentIntent.client_secret,
      };
    } catch (error: any) {
      throw new Error(
        `Error creating mobile checkout session: ${error.message}`
      );
    }
  }

  // Web flow: create a standard Checkout session
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: { name: "Deposit" },
            unit_amount: amountCent,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: currency,
            product_data: { name: "Tax" },
            unit_amount: taxAmountCent,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${publicUrl}${isProduction ? "" : ":3000"}/stripe-popup-success.html?sessionId={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}${isProduction ? "" : ":3000"}/stripe-popup-cancel.html`,
    });

    return {
      version: (stripe as any).VERSION,
      id: session.id,
      url: session.url,
    };
  } catch (error: any) {
    throw new Error(`Error creating checkout session: ${error.message}`);
  }
};
