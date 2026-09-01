export type TransactionCategory =
  | 'Dining'
  | 'Grocery'
  | 'Transport'
  | 'Rent'
  | 'Bills'
  | 'P2P Transfer'
  | 'Investment'
  | 'Others';

export type TransactionType = 'Debit' | 'Credit';

export type TransactionSource = 'Voice-only' | 'SMS-parsed' | 'Merged';

export interface Transaction {
  id: string;
  amount: number;
  title: string;
  category: TransactionCategory;
  paidTo: string;
  accountInfo: string;
  transactionType: TransactionType;
  timestamp: string;
  source: TransactionSource;
}

