import * as Sequelize from "sequelize";
import { DataTypes, Model } from "sequelize";
import p2pOffer from "./p2pOffer";
import user from "./user";

export default class p2pPaymentMethod
  extends Model<p2pPaymentMethodAttributes, p2pPaymentMethodCreationAttributes>
  implements p2pPaymentMethodAttributes
{
  id!: string;
  userId!: string;
  name!: string;
  instructions!: string;
  currency!: string;
  chain?: string;
  walletType!: "FIAT" | "SPOT" | "ECO";
  image?: string;
  status!: boolean;
  createdAt?: Date;
  deletedAt?: Date;
  updatedAt?: Date;

  // p2pPaymentMethod hasMany p2pOffer via paymentMethodId
  p2pOffers!: p2pOffer[];
  getP2pOffers!: Sequelize.HasManyGetAssociationsMixin<p2pOffer>;
  setP2pOffers!: Sequelize.HasManySetAssociationsMixin<p2pOffer, p2pOfferId>;
  addP2pOffer!: Sequelize.HasManyAddAssociationMixin<p2pOffer, p2pOfferId>;
  addP2pOffers!: Sequelize.HasManyAddAssociationsMixin<p2pOffer, p2pOfferId>;
  createP2pOffer!: Sequelize.HasManyCreateAssociationMixin<p2pOffer>;
  removeP2pOffer!: Sequelize.HasManyRemoveAssociationMixin<
    p2pOffer,
    p2pOfferId
  >;
  removeP2pOffers!: Sequelize.HasManyRemoveAssociationsMixin<
    p2pOffer,
    p2pOfferId
  >;
  hasP2pOffer!: Sequelize.HasManyHasAssociationMixin<p2pOffer, p2pOfferId>;
  hasP2pOffers!: Sequelize.HasManyHasAssociationsMixin<p2pOffer, p2pOfferId>;
  countP2pOffers!: Sequelize.HasManyCountAssociationsMixin;
  // p2pPaymentMethod belongsTo user via userId
  user!: user;
  getUser!: Sequelize.BelongsToGetAssociationMixin<user>;
  setUser!: Sequelize.BelongsToSetAssociationMixin<user, userId>;
  createUser!: Sequelize.BelongsToCreateAssociationMixin<user>;

  public static initModel(sequelize: Sequelize.Sequelize): typeof p2pPaymentMethod {
    return p2pPaymentMethod.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        userId: {
          type: DataTypes.UUID,
          allowNull: false,
        },
        name: {
          type: DataTypes.STRING(255),
          allowNull: false,
          validate: {
            notEmpty: { msg: "name: Name cannot be empty" },
          },
        },
        instructions: {
          type: DataTypes.TEXT,
          allowNull: false,
          validate: {
            notEmpty: { msg: "instructions: Instructions cannot be empty" },
          },
        },
        currency: {
          type: DataTypes.STRING(191),
          allowNull: false,
          defaultValue: "USD",
          validate: {
            notEmpty: { msg: "currency: Currency cannot be empty" },
          },
        },
        chain: {
          type: DataTypes.STRING(191),
          allowNull: true,
        },
        walletType: {
          type: DataTypes.ENUM("FIAT", "SPOT", "ECO"),
          allowNull: false,
          defaultValue: "FIAT",
          validate: {
            isIn: {
              args: [["FIAT", "SPOT", "ECO"]],
              msg: "walletType: Wallet type must be either FIAT, SPOT, or ECO",
            },
          },
        },
        image: {
          type: DataTypes.STRING(1000),
          allowNull: true,
        },
        status: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
          validate: {
            isBoolean: { msg: "status: Status must be a boolean value" },
          },
        },
      },
      {
        sequelize,
        modelName: "p2pPaymentMethod",
        tableName: "p2p_payment_method",
        timestamps: true,
        paranoid: true,
        indexes: [
          {
            name: "PRIMARY",
            unique: true,
            using: "BTREE",
            fields: [{ name: "id" }],
          },
          {
            name: "p2pPaymentMethodUserIdFkey",
            using: "BTREE",
            fields: [{ name: "userId" }],
          },
        ],
      }
    );
  }
  public static associate(models: any) {
    p2pPaymentMethod.hasMany(models.p2pOffer, {
      as: "p2pOffers",
      foreignKey: "paymentMethodId",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    });
    p2pPaymentMethod.belongsTo(models.user, {
      as: "user",
      foreignKey: "userId",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    });
  }
}
