import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "./graph/graph.service";
import { ContractService } from "./contract/contract.service";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private graphService: GraphService,
    private contractService: ContractService,
  ) {}

  async init() {
    this.logger.debug("Setup Users service");
    const accounts = await this._queryAccounts();
  }

  async run() {
    this.logger.debug("Hello");
  }

  async _queryAccounts() {
    this.logger.debug(`Fetch accounts from graph`);
    const accountsFromGraph = await this.graphService.getAllAddresses();
    this.logger.debug(`${accountsFromGraph.length} accounts fetched on graph`);
  }
}
