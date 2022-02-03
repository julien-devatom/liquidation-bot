import { Injectable } from "@nestjs/common";
import { BigNumber, ethers, Transaction, Wallet } from "ethers";
import * as LendingPool from "../../abis/lendingPool.json";
import * as DataProvider from "../../abis/ProtocolDataProvider.json";
import * as PriceOracle from "../../abis/PriceOracle.json";
import * as LiquidatorForAave from "../../abis/LiquidatorForAave.json";

export interface MarketConfig {
  address: string;
  symbol: string;
  decimals: number;
  liquidationThreshold: BigNumber;
  liquidationBonus: BigNumber;
  supplyIndex: BigNumber;
  borrowIndex: BigNumber;
  aTokenAddress: string;
  stableDebtTokenAddress: string;
  variableDebtTokenAddress: string;
  ethPrice: BigNumber;
}

export const RAY = BigNumber.from(10).pow(27);

function computeSwapFees(
  debtAssetAToken: string,
  collateralAssetAToken: string,
) {
  const stableCoinsATokens = [
    "0x27f8d03b3a2196956ed754badc28d73be8830a6e", // DAI
    "0x1a13f4ca1d028320a707d99520abfefca3998b7f", // USDC,
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  ];
  const exoticCoinsATokens = [
    "0x0Ca2e42e8c21954af73Bc9af1213E4e81D6a669A".toLowerCase(), // LINK
    "0x21eC9431B5B55c5339Eb1AE7582763087F98FAc2".toLowerCase(), // SUSHI
    "0x3Df8f92b7E798820ddcCA2EBEA7BAbda2c90c4aD".toLowerCase(), // CRV
    "0x81fB82aAcB4aBE262fc57F06fD4c1d2De347D7B1".toLowerCase(), // DPI
    "0xc4195D4060DaEac44058Ed668AA5EfEc50D77ff6".toLowerCase(), // BAL
    "0x080b5BF8f360F624628E0fb961F4e67c9e3c7CF1".toLowerCase(), // GHST
  ];
  let fees = "3000";
  if (
    stableCoinsATokens.includes(debtAssetAToken.toLowerCase()) &&
    stableCoinsATokens.includes(collateralAssetAToken.toLowerCase())
  )
    fees = "500";
  else if (
    exoticCoinsATokens.includes(debtAssetAToken.toLowerCase()) ||
    exoticCoinsATokens.includes(collateralAssetAToken.toLowerCase())
  )
    fees = "10000";
  return fees;
}

@Injectable()
export class ContractService {
  private config = {
    LENDING_POOL: {
      address: "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf",
      abi: LendingPool,
    },
    PROTOCOL_DATA_PROVIDER: {
      address: "0x7551b5D2763519d4e37e8B81929D336De671d46d",
      abi: DataProvider,
    },
    PRICE_ORACLE: {
      address: "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d",
      abi: PriceOracle,
    },
    LIQUIDATION_WRAPPER: {
      address: process.env.LIQUIDATOR_CONTRACT_ADDRESS,
      abi: LiquidatorForAave,
    },
    network: {
      chainID: 137,
      RPC: process.env.RPC_URL,
    },
  };

  provider = new ethers.providers.JsonRpcProvider(
    this.config.network.RPC,
    this.config.network.chainID,
  );
  private lendingPoolContract = new ethers.Contract(
    this.config.LENDING_POOL.address,
    this.config.LENDING_POOL.abi,
    this.provider,
  );
  private protocolDataProvider = new ethers.Contract(
    this.config.PROTOCOL_DATA_PROVIDER.address,
    this.config.PROTOCOL_DATA_PROVIDER.abi,
    this.provider,
  );
  private priceOracle = new ethers.Contract(
    this.config.PRICE_ORACLE.address,
    this.config.PRICE_ORACLE.abi,
    this.provider,
  );

  async getUserConfig(address: string): Promise<UserConfig> {
    return this.lendingPoolContract
      .getUserAccountData(address)
      .catch(() => console.log(`Error when fetch config of user ${address}`));
  }

  async _getMarkets(): Promise<MarketConfig[]> {
    type TokenData = { symbol: string; tokenAddress: string };
    return this.protocolDataProvider
      .getAllReservesTokens()
      .then(async (tokens: TokenData[]) =>
        Promise.all(
          tokens.map(async ({ symbol, tokenAddress }) => {
            const { decimals, liquidationThreshold, liquidationBonus } =
              await this.protocolDataProvider.getReserveConfigurationData(
                tokenAddress,
              );
            const {
              aTokenAddress,
              stableDebtTokenAddress,
              variableDebtTokenAddress,
            } = await this.protocolDataProvider.getReserveTokensAddresses(
              tokenAddress,
            );
            const { supplyIndex, borrowIndex, stableBorrowIndex } =
              await this.getNewRates(tokenAddress);

            const ethPrice = await this.priceOracle.getAssetPrice(tokenAddress);
            return <MarketConfig>{
              address: tokenAddress,
              symbol,
              decimals,
              liquidationThreshold,
              liquidationBonus,
              aTokenAddress,
              stableDebtTokenAddress,
              variableDebtTokenAddress,
              supplyIndex,
              borrowIndex,
              stableBorrowIndex,
              ethPrice,
            };
          }),
        ),
      );
  }

  async getNewRates(address: string) {
    const { liquidityRate, variableBorrowRate, stableBorrowRate } =
      await this.protocolDataProvider.getReserveData(address);
    const borrowIndex =
      await this.lendingPoolContract.getReserveNormalizedVariableDebt(address);
    // const supplyRate =
    //   await this.lendingPoolContract.getReserveNormalizedIncome(address);
    // equal to liquidity rate
    return {
      supplyIndex: liquidityRate,
      borrowIndex,
      stableBorrowIndex: stableBorrowRate,
    };
  }

  async getBalancesInOf(
    address: string,
    accountAddress: string,
  ): Promise<UserBalance> {
    return <UserBalance>(
      this.protocolDataProvider
        .getUserReserveData(address, accountAddress)
        .catch(() =>
          console.log(
            `Error when fetch balance in ${address} of user ${accountAddress}`,
          ),
        )
    );
  }

  async liquidate(
    debtAssetAToken: string,
    collateralAssetAToken: string,
    borrower: string,
    debtAmount: BigNumber,
    gasPrice: BigNumber,
  ) {
    const signer = new Wallet(process.env.PRIVATE_KEY, this.provider);
    const fees = computeSwapFees(debtAssetAToken, collateralAssetAToken);
    console.timeLog(
      `liquidation#${borrower.toLowerCase()}`,
      "Call to Liquidator contract",
    );
    const liquidationContract = new ethers.Contract(
      this.config.LIQUIDATION_WRAPPER.address,
      this.config.LIQUIDATION_WRAPPER.abi,
      signer,
    );
    return liquidationContract
      .connect(signer)
      .liquidate(
        borrower,
        debtAssetAToken,
        collateralAssetAToken,
        debtAmount.toString(),
        fees,
        {
          gasPrice,
          gasLimit: 28_000_000, // gasLimit is 30M for polygon
        },
      );
  }
}

export interface UserConfig {
  totalCollateralETH: BigNumber;
  totalDebtETH: BigNumber;
  availableBorrowETH: BigNumber;
  currentLiquidationThreshold: BigNumber;
  healthFactor: BigNumber;
}

export interface UserBalance {
  currentATokenBalance: BigNumber;
  currentStableDebt: BigNumber;
  currentVariableDebt: BigNumber;
  principalStableDebt: BigNumber;
  scaledVariableDebt: BigNumber;
  stableBorrowRate: BigNumber;
  liquidityRate: BigNumber;
  stableRateLastUpdated: BigNumber;
  usageAsCollateralEnabled: boolean;
}

export interface BalanceWithMarket {
  market: MarketConfig;
  currentATokenBalance: BigNumber;
  currentStableDebt: BigNumber;
  currentVariableDebt: BigNumber;
  principalStableDebt: BigNumber;
  scaledVariableDebt: BigNumber;
  stableBorrowRate: BigNumber;
  liquidityRate: BigNumber;
  stableRateLastUpdated: BigNumber;
  usageAsCollateralEnabled: boolean;
}

export interface UserWithBalances {
  address: string;
  totalCollateralETH: BigNumber;
  totalDebtETH: BigNumber;
  availableBorrowETH: BigNumber;
  currentLiquidationThreshold: BigNumber;
  healthFactor: BigNumber;
  balances: BalanceWithMarket[];
}

export interface TransactionResponse extends Transaction {
  hash: string;

  // Only if a transaction has been mined
  blockNumber?: number;
  blockHash?: string;
  timestamp?: number;

  confirmations: number;

  // Not optional (as it is in Transaction)
  from: string;

  // The raw transaction
  raw?: string;

  // This function waits until the transaction has been mined
  wait: (confirmations?: number) => Promise<TransactionReceipt>;
}

export interface TransactionReceipt {
  to: string;
  from: string;
  contractAddress: string;
  transactionIndex: number;
  root?: string;
  gasUsed: BigNumber;
  logsBloom: string;
  blockHash: string;
  transactionHash: string;
  logs: Array<any>;
  blockNumber: number;
  confirmations: number;
  cumulativeGasUsed: BigNumber;
  effectiveGasPrice: BigNumber;
  byzantium: boolean;
  type: number;
  status?: number;
}
