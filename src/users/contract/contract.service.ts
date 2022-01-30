import { Injectable } from "@nestjs/common";
import { BigNumber, ethers } from "ethers";
import * as LendingPool from "../../abis/lendingPool.json";
import * as DataProvider from "../../abis/ProtocolDataProvider.json";
import * as PriceOracle from "../../abis/PriceOracle.json";

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
    network: {
      chainID: 137,
      RPC: process.env.RPC_URL,
    },
  };

  private provider = new ethers.providers.JsonRpcProvider(
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
