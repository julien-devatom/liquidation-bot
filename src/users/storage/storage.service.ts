import { Injectable } from "@nestjs/common";
import * as Redis from "ioredis";
import { AccountWithBalanceDTO } from "../dto/accounts.dto";

@Injectable()
export class StorageService {
  private readonly ALL_ACCOUNTS = "AAVE#allAccounts";
  private readonly ACCOUNTS_TO_TRACK = "AAVE#accountToTrack";
  private readonly ACCOUNTS_BLACKLIST = "AAVE#blacklist";
  private redis = new Redis("redis://localhost:6379");
  private readonly TRACKING_DELAY = 3600;

  async getAllSavedAccounts(): Promise<string[]> {
    return await this.redis.smembers(this.ALL_ACCOUNTS);
  }

  async addAccounts(acc: string[]): Promise<void> {
    await this.redis.sadd(this.ALL_ACCOUNTS, acc);
  }

  async accountExist(acc: string): Promise<boolean> {
    return !!(await this.redis.sismember(this.ALL_ACCOUNTS, acc));
  }

  async getAccountsToTrack(acc: string): Promise<AccountWithBalanceDTO[]> {
    const accountToTrack = await this.redis.smembers(this.ACCOUNTS_TO_TRACK);
    return await Promise.all(accountToTrack.map(this._getAccountBalance));
  }

  async _getAccountBalance(address: string): Promise<AccountWithBalanceDTO> {
    return JSON.parse(
      await this.redis.get(`AAVE#${address.toLowerCase()}`),
    ) as AccountWithBalanceDTO;
  }

  async saveUserBalances(acc: AccountWithBalanceDTO): Promise<void> {
    this.redis.set(acc.address, JSON.stringify(acc));
  }

  async addTrackedAccount(acc: string): Promise<void> {
    if (!(await this.isBlackListed(acc)))
      await this.redis.sadd(this.ACCOUNTS_TO_TRACK, acc);
  }

  async addAccountsToTrack(acc: string[], limit: number): Promise<string[]> {
    const accs = acc.filter(async (acc) => !(await this.isBlackListed(acc)));
    await this.redis.sadd(this.ACCOUNTS_TO_TRACK, accs.slice(0, limit));
    return accs.slice(0, limit);
  }

  async isBlackListed(acc: string): Promise<boolean> {
    return !!(await this.redis.sismember(this.ACCOUNTS_BLACKLIST, acc));
  }

  async getAddressesToTrack(): Promise<string[]> {
    return this.redis.smembers(this.ACCOUNTS_TO_TRACK);
  }

  async removeTrackedAccount(acc: string[]): Promise<void> {
    await this.redis.srem(this.ACCOUNTS_TO_TRACK, acc);
  }
}
