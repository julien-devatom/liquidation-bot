import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "./graph/graph.service";
import {
  BalanceWithMarket,
  ContractService,
  MarketConfig,
  UserConfig,
} from "./contract/contract.service";
import { StorageService } from "./storage/storage.service";
import * as fs from "fs";
import { BigNumber, ContractTransaction, ethers } from "ethers";
import { formatEther, formatUnits } from "ethers/lib/utils";

@Injectable()
export class UsersService {
  private LIMIT_ACCOUNTS_TO_TRACK = 80;
  private markets: MarketConfig[];
  private tracked: string[];
  private readonly logger = new Logger(UsersService.name);
  private usersWithBalances;

  constructor(
    private graphService: GraphService,
    private contractService: ContractService,
    private storage: StorageService,
  ) {}

  async init() {
    this.logger.debug("Setup Users service");
    await this._initMarkets();
    await this._initAccounts();
    //await this._updateTrackedAccounts();
  }

  async run() {
    this.logger.debug("Start Tracking of accounts");
    while (true) {
      await this._loop();
      await sleep(10000); // wait during 10s
    }
  }

  async _queryAccounts() {
    this.logger.debug(`Fetch accounts from graph`);
    const accountsFromGraph = await this.graphService.getAllAddresses();
    this.logger.debug(`${accountsFromGraph.length} accounts fetched on graph`);
    return accountsFromGraph;
  }

  async _initAccounts() {
    const accountsToTrack = await this.storage.getAddressesToTrack();
    if (accountsToTrack.length < this.LIMIT_ACCOUNTS_TO_TRACK) {
      let addresses = await this.storage.getAllSavedAccounts();
      if (addresses.length === 0) addresses = await this._queryAccounts();
      let accountsData: (UserConfig & { address: string })[] = [];
      const loop = 500;
      let offset = 0;
      // parallelize RPC call 500 by 500
      while (offset < addresses.length) {
        const accountsToCompute = addresses.slice(
          offset,
          Math.min(offset + loop, addresses.length),
        );
        const loopAccountData = await Promise.all(
          accountsToCompute.map(async (address) => {
            //this.logger.debug(`Get userConfig for account ${i}: ${address}`);
            const config = await this.contractService.getUserConfig(address);
            this.logger.verbose(config);
            return {
              ...config,
              address,
            };
          }),
        );
        accountsData = [...accountsData, ...loopAccountData];
        this.logger.debug(`${accountsData.length} HF fetched`);
        offset += loop;
      }

      const sorted = accountsData
        .filter((acc) => !!acc.healthFactor)
        .sort((acc1, acc2) =>
          BigNumber.from(acc1.healthFactor).gt(acc2.healthFactor) ? 1 : -1,
        )
        .filter(
          (acc) =>
            acc.totalDebtETH.gt(ethers.utils.parseEther("0.001")) &&
            acc.healthFactor.gt(ethers.utils.parseEther("1")),
          // we suppose that, if an account is not already liquidated is due to a no benefical liquidation
        ); // 0.01 ETH
      await fs.promises.writeFile(
        "dump.json",
        JSON.stringify(
          sorted.slice(0, this.LIMIT_ACCOUNTS_TO_TRACK).map((s) => ({
            hf: ethers.utils.formatEther(s.healthFactor),
            debt: formatEther(s.totalDebtETH),
            collateral: formatEther(s.totalCollateralETH),
          })),
          null,
          4,
        ),
      );
      if (sorted.length === 0) throw new Error("There is no accounts to track");
      this.tracked = await this.storage.addAccountsToTrack(
        sorted.map((s) => s.address),
        this.LIMIT_ACCOUNTS_TO_TRACK,
      );
    } else {
      this.logger.debug("Get tracked accounts from storage");
      this.tracked = accountsToTrack;
    }
    this.logger.debug(`${this.tracked.length} accounts tracked`);
  }

  async _initMarkets() {
    this.markets = await this.contractService._getMarkets();
    this.logger.debug(`${this.markets.length} markets initialized`);
    await fs.promises.writeFile(
      "dump-markets.json",
      JSON.stringify(this.markets, null, 4),
    );
  }

  async _updateTrackedAccounts() {
    this.usersWithBalances = await Promise.all(
      this.tracked.map(async (accountAddress) => {
        const balances: BalanceWithMarket[] = await this._getUserBalances(
          accountAddress,
        );
        const userConfig = await this.contractService.getUserConfig(
          accountAddress,
        );
        return {
          address: accountAddress,
          ...userConfig,
          balances,
        };
      }),
    );
  }

  async _loop() {
    const previousTracked = this.tracked;
    this.tracked = await Promise.all(
      this.tracked.map(async (accountAddress) => {
        const userData = await this.contractService.getUserConfig(
          accountAddress,
        );
        let toRemove = false;

        if (userData.healthFactor.lte(ethers.utils.parseEther("1"))) {
          this._liquidateAccount(accountAddress);
          toRemove = true;
        } else if (userData.healthFactor.gt(ethers.utils.parseEther("1.004"))) {
          this.logger.debug(
            `account ${accountAddress} untracked, due to a HF equal to ${formatEther(
              userData.healthFactor,
            )} > 1.004 `,
          );
          toRemove = true;
        }
        if (toRemove) {
          this.storage.removeTrackedAccount([accountAddress]);
        }
        this.logger.debug(
          `Account : ${accountAddress}: ${formatEther(userData.healthFactor)}`,
        );
        if (toRemove) {
          this.logger.debug(
            `Account ${accountAddress} removed with HF ${formatEther(
              userData.healthFactor,
            )}`,
          );
        }
        return {
          hf: userData.healthFactor,
          toRemove,
          address: accountAddress,
        };
      }),
    ).then((accs) =>
      accs
        .filter((acc) => !acc.toRemove)
        .sort((acc1, acc2) => (acc1.hf.gt(acc2.hf) ? 1 : -1))
        .map((acc) => acc.address),
    );
    this.logger.debug(
      `${this.tracked.length} accounts tracked, ${
        previousTracked.length - this.tracked.length
      } accounts liquidated or untracked`,
    );
  }

  async _liquidateAccount(accountAddress: string) {
    await this._initMarkets(); // update price
    const balances = await this._getUserBalances(accountAddress);
    const repayBalance = this._selectDebtToken(balances);
    const collateralBalance = this._selectCollateralToken(balances);
    const debtAmount = repayBalance.currentVariableDebt.div(2); //this._selectDebtAmount(repayBalance, collateralBalance);
    const tx: ContractTransaction = await this.contractService.liquidate(
      repayBalance.market.aTokenAddress,
      collateralBalance.market.aTokenAddress,
      accountAddress,
      debtAmount,
    );
    this.logger.debug(`Liquidation transaction : ${tx.hash}
      block : ${tx.blockNumber}
    `);
    let err = null;
    await tx.wait().catch((e) => (err = e));
    if (err !== null) {
      this.logger.error("Liquidation fail");
      this.logger.error(err);
    } else {
      this.logger.log("Liquidation successful !!");
    }

    const amountRewarded = debtAmount
      .mul(repayBalance.market.ethPrice)
      .mul(collateralBalance.market.decimals)
      .div(repayBalance.market.decimals)
      .div(collateralBalance.market.ethPrice)
      .mul(collateralBalance.market.liquidationBonus)
      .div(10000);
    //liquidation call
    this.logger.debug(
      `
      
      LIQUIDATION : ${accountAddress} at ${Date.now() / 1000} with parameters :
      Collateral : ${collateralBalance.market.symbol}
      Debt : ${ethers.utils.formatUnits(
        debtAmount,
        repayBalance.market.decimals,
      )} of ${collateralBalance.market.symbol}
      Rewards estimated (without fees) : ${ethers.utils.formatUnits(
        amountRewarded,
        collateralBalance.market.decimals,
      )} of ${collateralBalance.market.symbol}
      `,
    );

    const liquidationParams = {
      collateral: collateralBalance,
      debt: repayBalance,
      amount: formatUnits(debtAmount, repayBalance.market.decimals),
      rewardsETH: formatEther(amountRewarded),
    };
    await fs.promises.writeFile(
      `liquidations/${Date.now()}.json`,
      JSON.stringify(liquidationParams, null, 4),
    );
    process.exit(err ? 0 : 1);
  }

  _selectDebtAmount(
    debtBalance: BalanceWithMarket,
    collateralBalance: BalanceWithMarket,
  ): BigNumber {
    const debtAmount = debtBalance.currentVariableDebt.div(2);
    return debtAmount
      .mul(debtBalance.market.ethPrice)
      .lte(
        collateralBalance.currentATokenBalance.mul(
          collateralBalance.market.ethPrice,
        ),
      )
      ? debtAmount
      : collateralBalance.currentATokenBalance
          .mul(collateralBalance.market.ethPrice)
          .div(debtBalance.market.ethPrice)
          .mul(debtBalance.market.decimals)
          .div(collateralBalance.market.decimals);
  }

  _selectDebtToken(balances: BalanceWithMarket[]) {
    const [selectedDebtMarket] = balances
      .map((b) => ({
        selector: b.market.address,
        amount: b.currentVariableDebt
          .mul(b.market.ethPrice)
          .mul(BigNumber.from(10).pow(18 - b.market.decimals)),
      }))
      .sort((b1, b2) => (b1.amount.lt(b2.amount) ? 1 : -1));
    return balances.find(
      (b) => b.market.address === selectedDebtMarket.selector,
    );
  }

  _selectCollateralToken(balances: BalanceWithMarket[]) {
    const [selectedCollateralMarket] = balances
      .map((b) => ({
        selector: b.market.address,
        amount: b.currentATokenBalance
          .mul(b.market.ethPrice)
          .mul(BigNumber.from(10).pow(18 - b.market.decimals))
          .mul(b.market.liquidationBonus),
      }))
      .sort((b1, b2) => (b1.amount.lt(b2.amount) ? 1 : -1));
    return balances.find(
      (b) => b.market.address === selectedCollateralMarket.selector,
    );
  }

  async _getUserBalances(accountAddress: string): Promise<BalanceWithMarket[]> {
    return Promise.all(
      this.markets.map(async (market) => {
        const balance = await this.contractService.getBalancesInOf(
          market.address,
          accountAddress,
        );
        return {
          market,
          ...balance,
        };
      }),
    );
  }

  _computeHF(balances: BalanceWithMarket[]): BigNumber {
    const collateral = balances
      .map((b) =>
        b.currentATokenBalance
          // .mul(b.market.supplyIndex)
          .mul(b.market.liquidationThreshold)
          .mul(b.market.ethPrice)
          .div(10000),
      )
      .reduce((prev, curr) => prev.add(curr), BigNumber.from(0));
    const debt = balances
      .map((b) =>
        b.currentVariableDebt
          // .mul(b.market.borrowIndex)
          .mul(b.market.ethPrice),
      )
      .reduce((prev, curr) => prev.add(curr), BigNumber.from(0));
    return collateral.mul(ethers.utils.parseEther("1")).div(debt);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
