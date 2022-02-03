import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "./graph/graph.service";
import {
  BalanceWithMarket,
  ContractService,
  MarketConfig,
  TransactionResponse,
  UserConfig,
} from "./contract/contract.service";
import { StorageService } from "./storage/storage.service";
import * as fs from "fs";
import { BigNumber, ContractTransaction, ethers } from "ethers";
import { formatEther, formatUnits, parseEther } from "ethers/lib/utils";

@Injectable()
export class UsersService {
  private LIMIT_ACCOUNTS_TO_TRACK = 200;
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
      //await sleep(10000); // wait during 10s
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
            acc.totalDebtETH.gt(ethers.utils.parseEther("0.0001")) &&
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
    let minHF = parseEther("10");
    const previousTracked = this.tracked;
    this.tracked = await Promise.all(
      this.tracked.map(async (accountAddress) => {
        const userData = await this.contractService.getUserConfig(
          accountAddress,
        );
        let toRemove = false;
        if (!userData?.healthFactor) {
          toRemove = true;
          this.logger.debug(
            `Remove account ${accountAddress} due to an error during HF computation`,
          );
        } else if (userData.healthFactor.lte(ethers.utils.parseEther("1"))) {
          console.time(`liquidation#${accountAddress.toLowerCase()}`);
          this._liquidateAccount(accountAddress);
          toRemove = true;
        } else if (userData.healthFactor.gt(ethers.utils.parseEther("1.01"))) {
          this.logger.debug(
            `account ${accountAddress} untracked, due to a HF equal to ${formatEther(
              userData.healthFactor,
            )} > 1.01 `,
          );
          toRemove = true;
        }
        if (toRemove) {
          this.storage.removeTrackedAccount([accountAddress]);
        } else {
          if (minHF.gt(userData.healthFactor)) {
            minHF = userData.healthFactor;
          }
        }
        // this.logger.debug(
        //   `Account : ${accountAddress}: ${formatEther(userData.healthFactor)}`,
        // );
        if (toRemove) {
          this.logger.debug(
            `Account ${accountAddress} removed with HF ${
              userData?.healthFactor ? formatEther(userData.healthFactor) : ""
            }`,
          );
        }
        return {
          hf: userData?.healthFactor,
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
      } accounts liquidated or untracked, min HF = ${formatEther(minHF)}`,
    );
  }

  async _liquidateAccount(accountAddress: string) {
    await this._initMarkets(); // update price

    const stableCoinsATokens = [];
    const balances = await this._getUserBalances(accountAddress);
    const repayBalance = this._selectDebtToken(balances);
    const collateralBalance = this._selectCollateralToken(balances);
    const debtAmount = repayBalance.currentVariableDebt.div(2); //this._selectDebtAmount(repayBalance, collateralBalance);
    const debtETH = debtAmount
      .mul(repayBalance.market.ethPrice)
      .div(BigNumber.from(10).pow(repayBalance.market.decimals));
    const gasPriceBase = gasFromdebtETH(debtETH);
    const gasPrice = BigNumber.from(gasPriceBase).mul(
      BigNumber.from(10).pow(9),
    );
    this.logger.debug(
      `Gas price : ${gasPrice.toString()}, gasPriceBase: ${gasPriceBase}`,
    );
    const tx: ContractTransaction = await this.contractService.liquidate(
      repayBalance.market.aTokenAddress,
      collateralBalance.market.aTokenAddress,
      accountAddress,
      debtAmount,
      gasPrice,
    );
    this.logger.debug(`Liquidation transaction : ${tx.hash}
      block : ${tx.blockNumber}
      from: ${tx.from}
    `);
    const amountRewarded = debtAmount
      .mul(repayBalance.market.ethPrice)
      .mul(collateralBalance.market.decimals)
      .div(repayBalance.market.decimals)
      .div(collateralBalance.market.ethPrice)
      .mul(collateralBalance.market.liquidationBonus)
      .div(10000);

    // const flashLoanAmountWithFeesInDebtToken = debtAmount.mul(10009).div(10000);
    // const bonusAmountWith;
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
    mempoolTracking(tx, accountAddress, this.contractService.provider);
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
          .div(BigNumber.from(10).pow(b.market.decimals)),
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
          .div(BigNumber.from(10).pow(b.market.decimals))
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
const gasFromdebtETH = (debtEth: BigNumber) => {
  const debt = +formatEther(debtEth);
  const A = 29.9895;
  const k = 3.50691;
  const gasCost = Math.floor(Math.min(10000, A * Math.exp(k * debt)));
  console.log("GWEI amount for gas :" + gasCost.toString());
  return gasCost;
};

async function mempoolTracking(
  myTx: TransactionResponse,
  borrowerAddress: string,
  provider,
) {
  const startTime = Date.now();
  const WSS_ENDPOINT =
    "wss://polygon-mainnet.g.alchemy.com/v2/8_CtN09YVwbPJkIEjFijDf5y4M6wmUD0";
  const WsProvider = new ethers.providers.WebSocketProvider(
    WSS_ENDPOINT,
    provider.network.chainId,
  );
  let editedTxHash = [myTx.hash];
  const {
    from,
    to,
    nonce,
    gasLimit,
    gasPrice,
    data,
    value,
    chainId,
    type,
    accessList,
  } = myTx;
  myTx
    .wait()
    .then((r) => {
      WsProvider.removeAllListeners("pending");
      console.log(
        "Stop mempool tracking with successful transaction without gas increment",
      );
      console.timeEnd(`liquidation#${borrowerAddress.toLowerCase()}`);
    })
    .catch((e) => {
      editedTxHash = editedTxHash.filter((h) => h !== myTx.hash);
      if (editedTxHash.length === 0) {
        console.log("Stop mempool tracking with an error...");
        WsProvider.removeAllListeners("pending");
        console.timeEnd(`liquidation#${borrowerAddress.toLowerCase()}`);
      }
    });
  const track = borrowerAddress.slice(2, borrowerAddress.length);
  let myGasCost = gasPrice;
  let increasedGasCost;
  const myPublicAddr = "0x00";
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log("Start mempool tracking");
  WsProvider.on("pending", async (tx) => {
    WsProvider.getTransaction(tx).then(async (transaction) => {
      if (transaction === null) return;
      if (
        transaction?.from?.toLowerCase() !== myPublicAddr.toLowerCase() &&
        transaction?.data?.includes(track)
      ) {
        console.log(
          "Found an address which trying to liquidate :",
          transaction.from,
        );
        if (transaction.gasPrice.gt(myGasCost)) {
          increasedGasCost = transaction.gasPrice.mul(11).div(10); // + 10% gas
          const newTx = {
            to,
            from,
            nonce,
            gasLimit,
            gasPrice: increasedGasCost,
            data,
            value,
            chainId,
            type,
            accessList,
          };
          const signedTx = await wallet.signTransaction(newTx);
          const tx = await provider.sendTransaction(signedTx);
          tx.wait()
            .then((r) => {
              console.log("Stop mempool tracking with successful liquidation");
              WsProvider.removeAllListeners("pending");
              console.timeEnd(`liquidation#${borrowerAddress.toLowerCase()}`);
            })
            .catch((e) => {
              editedTxHash = editedTxHash.filter((h) => h !== tx.hash);
              if (editedTxHash.length === 0) {
                console.log("Stop mempool tracking with an error...");
                WsProvider.removeAllListeners("pending");
                console.timeEnd(`liquidation#${borrowerAddress.toLowerCase()}`);
              }
            });
          myGasCost = increasedGasCost;
          editedTxHash.push(tx.hash);
          // increase our gas cost
        } else {
          console.log(
            "Our gas price is greater of ",
            formatUnits(myGasCost.sub(transaction.gasPrice), "gwei"),
            "gwei",
          );
        }
      }
    });
    if (Date.now() - startTime > 30000) {
      WsProvider.removeAllListeners("pending");
      console.timeEnd(`liquidation#${borrowerAddress.toLowerCase()}`);
      console.log("Stop mempool tracking due to timeout...");
    }
  });
}
