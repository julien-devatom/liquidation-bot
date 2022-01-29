import { Injectable } from "@nestjs/common";

@Injectable()
export class StorageService {
  getAllSavedAccounts;
  private REDIS_URL = "redis://localhost:6379";
}
