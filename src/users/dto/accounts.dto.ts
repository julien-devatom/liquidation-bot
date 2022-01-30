export interface AccountWithBalanceDTO {
  address: string;
  balances: Balance[];
  hf: string;
  collateralETH: string;
  collateralDebt: string;
}

export interface Balance {
  asset: Asset;
  balanceSupplied: string;
  balanceBorrowed: string;
  borrowIndex: string;
}

export interface Asset {
  address: string;
  underlying: string;
  symbol: string;
  decimals: string;
  collateralFactor: string;
  liquidationRewards: string;
}
