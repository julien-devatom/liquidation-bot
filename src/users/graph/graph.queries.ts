export const queryAllAccounts = `
query GetAccounts($first: Int, $lastID: ID){
  users(first: $first
  where: {
    borrowedReservesCount_gt: 0
    id_gt: $lastID
  }
  ) {
    id
    }
}`;

export interface QueryAllAccountsParameters {
  first: number;
  lastID: string;
}

export interface QueryAllAccountsReturnType {
  data: { data: { users: { id: string }[] } };
}
