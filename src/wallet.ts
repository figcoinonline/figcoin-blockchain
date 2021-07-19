import { ec } from "elliptic";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  readdir,
} from "fs";
import * as _ from "lodash";

import {
  getPublicKey,
  getTransactionId,
  signTxIn,
  Transaction,
  TxIn,
  TxOut,
  UnspentTxOut,
} from "./transaction";
import { getCurrentTimestamp } from "./blockchain";

const bs58 = require("bs58");
const EC = new ec("secp256k1");

class Wallet {
  public address: string;
  public publicKey: string;
  public privateKey: string;
  public length: number;
}

const masterPrivateKeyLocation =
  process.env.MASTER_PRIVATE_KEY || "node/wallet/master_private_key";
const nodesecretlocation =
  process.env.NODE_SECRET_LOCATION || "node/wallet/node_secret";

const getPrivateFromWallet = (): string => {
  const buffer = readFileSync(masterPrivateKeyLocation, "utf8");
  return buffer.toString();
};

const getNewFreeWallet = (): Wallet => {
  const keyPair = EC.genKeyPair();
  const privateKey = keyPair.getPrivate();
  const key = EC.keyFromPrivate(privateKey, "hex");
  const bytes = Buffer.from(key.getPublic(true, "hex"), "hex");
  const publicKey = bs58.encode(bytes);

  const walletObject: any = {
    address: publicKey,
    publicKey: publicKey,
    privateKey: privateKey,
    length: publicKey.length,
  };
  return walletObject;
};

const getPublicFromNodeWallet = (): string => {
  const privateKey = getPrivateFromWallet();
  const key = EC.keyFromPrivate(privateKey, "hex");
  const bytes = Buffer.from(key.getPublic(true, "hex"), "hex");
  const publicKey = bs58.encode(bytes);

  return publicKey;
};

const generatePrivateKey = (): string => {
  const keyPair = EC.genKeyPair();
  const privateKey = keyPair.getPrivate();
  return privateKey.toString(16);
};

const initMasterWallet = () => {
  if (existsSync(masterPrivateKeyLocation)) {
    return;
  }
  const newMasterPrivateKey = generatePrivateKey();
  const newNodeSecret = generatePrivateKey();

  writeFileSync(masterPrivateKeyLocation, newMasterPrivateKey);
  writeFileSync(nodesecretlocation, newNodeSecret);

  console.log(
    "new master wallet with private key created to : %s",
    masterPrivateKeyLocation
  );
  console.log(
    "new node secret with private key created to : %s",
    newNodeSecret
  );
};

const deleteWallet = () => {
  if (existsSync(masterPrivateKeyLocation)) {
    unlinkSync(masterPrivateKeyLocation);
  }
};

const getBalance = (address: string, unspentTxOuts: UnspentTxOut[]): number => {
  const walletBalance: number = 0;
  const transactionBalance: number = _(
    findUnspentTxOuts(address, unspentTxOuts)
  )
    .map((uTxO: UnspentTxOut) => uTxO.amount)
    .sum();

  return transactionBalance + walletBalance;
};

const findUnspentTxOuts = (
  ownerAddress: string,
  unspentTxOuts: UnspentTxOut[]
) => {
  return _.filter(
    unspentTxOuts,
    (uTxO: UnspentTxOut) => uTxO.address === ownerAddress
  );
};

const findTxOutsForAmount = (
  amount: number,
  myUnspentTxOuts: UnspentTxOut[]
) => {
  let currentAmount = 0;
  const includedUnspentTxOuts = [];
  for (const myUnspentTxOut of myUnspentTxOuts) {
    includedUnspentTxOuts.push(myUnspentTxOut);
    currentAmount = currentAmount + myUnspentTxOut.amount;
    if (currentAmount >= amount) {
      const leftOverAmount: number = currentAmount - amount;
      return { includedUnspentTxOuts, leftOverAmount };
    }
  }

  const eMsg =
    "Cannot create transaction from the available unspent transaction outputs." +
    " Required amount:" +
    amount +
    ". Available unspentTxOuts:" +
    JSON.stringify(myUnspentTxOuts);
  throw Error(eMsg);
};

const createTxOuts = (
  receiverAddress: string,
  myAddress: string,
  amount: number,
  leftOverAmount: number
) => {
  const txOut1: TxOut = new TxOut(receiverAddress, amount);
  if (leftOverAmount === 0) {
    return [txOut1];
  } else {
    const leftOverTx = new TxOut(myAddress, leftOverAmount);
    return [txOut1, leftOverTx];
  }
};

const filterTxPoolTxs = (
  unspentTxOuts: UnspentTxOut[],
  transactionPool: Transaction[]
): UnspentTxOut[] => {
  const txIns: TxIn[] = _(transactionPool)
    .map((tx: Transaction) => tx.txIns)
    .flatten()
    .value();
  const removable: UnspentTxOut[] = [];
  for (const unspentTxOut of unspentTxOuts) {
    const txIn = _.find(txIns, (aTxIn: TxIn) => {
      return (
        aTxIn.txOutIndex === unspentTxOut.txOutIndex &&
        aTxIn.txOutId === unspentTxOut.txOutId
      );
    });

    if (txIn === undefined) {
    } else {
      removable.push(unspentTxOut);
    }
  }

  return _.without(unspentTxOuts, ...removable);
};

const createTransaction = (
  receiverAddress: string,
  amount: number,
  privateKey: string,
  unspentTxOuts: UnspentTxOut[],
  txPool: Transaction[]
): Transaction => {
  console.log("txPool: %s", JSON.stringify(txPool));
  const myAddress: string = getPublicKey(privateKey);

  const myUnspentTxOutsA = unspentTxOuts.filter(
    (uTxO: UnspentTxOut) => uTxO.address === myAddress
  );

  const myUnspentTxOuts = filterTxPoolTxs(myUnspentTxOutsA, txPool);

  // filter from unspentOutputs such inputs that are referenced in pool
  const { includedUnspentTxOuts, leftOverAmount } = findTxOutsForAmount(
    amount,
    myUnspentTxOuts
  );

  const toUnsignedTxIn = (unspentTxOut: UnspentTxOut) => {
    const txIn: TxIn = new TxIn();
    txIn.txOutId = unspentTxOut.txOutId;
    txIn.txOutIndex = unspentTxOut.txOutIndex;
    return txIn;
  };

  const unsignedTxIns: TxIn[] = includedUnspentTxOuts.map(toUnsignedTxIn);

  const tx: Transaction = new Transaction();
  tx.txIns = unsignedTxIns;
  tx.txOuts = createTxOuts(receiverAddress, myAddress, amount, leftOverAmount);
  tx.id = getTransactionId(tx);
  tx.amount = amount;
  tx.receiver = receiverAddress;
  tx.sender = myAddress;

  tx.txIns = tx.txIns.map((txIn: TxIn, index: number) => {
    txIn.signature = signTxIn(tx, index, privateKey, unspentTxOuts);
    return txIn;
  });

  return tx;
};

const createFromWalletTransaction = (
  publicKey: string,
  amount: number,
  privateKey: string,
  receiverAddress: string,
  unspentTxOuts: UnspentTxOut[],
  txPool: Transaction[]
): Transaction => {
  console.log("txPool: %s", JSON.stringify(txPool));

  const senderAddress: string = getPublicKey(privateKey);

  if (publicKey !== senderAddress) {
    return null;
  }

  const myUnspentTxOutsA = unspentTxOuts.filter(
    (uTxO: UnspentTxOut) => uTxO.address === senderAddress
  );

  const myUnspentTxOuts = filterTxPoolTxs(myUnspentTxOutsA, txPool);

  // filter from unspentOutputs such inputs that are referenced in pool
  const { includedUnspentTxOuts, leftOverAmount } = findTxOutsForAmount(
    amount,
    myUnspentTxOuts
  );

  const toUnsignedTxIn = (unspentTxOut: UnspentTxOut) => {
    const txIn: TxIn = new TxIn();
    txIn.txOutId = unspentTxOut.txOutId;
    txIn.txOutIndex = unspentTxOut.txOutIndex;
    return txIn;
  };

  const unsignedTxIns: TxIn[] = includedUnspentTxOuts.map(toUnsignedTxIn);

  const tx: Transaction = new Transaction();
  tx.txIns = unsignedTxIns;
  tx.txOuts = createTxOuts(
    receiverAddress,
    senderAddress,
    amount,
    leftOverAmount
  );
  tx.id = getTransactionId(tx);
  tx.amount = amount;
  tx.receiver = receiverAddress;
  tx.sender = senderAddress;
  tx.timestamp = getCurrentTimestamp();

  tx.txIns = tx.txIns.map((txIn: TxIn, index: number) => {
    txIn.signature = signTxIn(tx, index, privateKey, unspentTxOuts);
    return txIn;
  });

  return tx;
};

export {
  createTransaction,
  getPublicFromNodeWallet,
  createFromWalletTransaction,
  Wallet,
  getPrivateFromWallet,
  getBalance,
  generatePrivateKey,
  initMasterWallet,
  deleteWallet,
  findUnspentTxOuts,
  getNewFreeWallet,
};
