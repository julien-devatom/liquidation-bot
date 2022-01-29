import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import {
  queryAllAccounts,
  QueryAllAccountsParameters,
  QueryAllAccountsReturnType,
} from "./graph.queries";

@Injectable()
export class GraphService {
  GRAPH_URL = "https://api.thegraph.com/subgraphs/name/aave/aave-v2-matic";
  private readonly logger = new Logger(GraphService.name);

  async getAllAddresses(): Promise<string[]> {
    let lastID = "";
    let hasMore = true;
    const first = 1000;
    let addresses: string[] = [];
    while (hasMore) {
      this.logger.verbose(
        `Graph fetch number ${addresses.length / first}, ${
          addresses.length
        } addresses fetched`,
      );
      const newAccounts = await axios
        .post<QueryAllAccountsParameters, QueryAllAccountsReturnType>(
          this.GRAPH_URL,
          {
            query: queryAllAccounts,
            variables: {
              lastID,
              first,
            },
          },
        )
        .then((r) => r.data.data.users.map((u) => u.id));

      hasMore = newAccounts.length === first;
      lastID = newAccounts[newAccounts.length - 1];
      addresses = [...addresses, ...newAccounts];
    }
    return addresses;
  }
}
