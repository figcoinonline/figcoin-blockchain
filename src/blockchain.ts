import { BigNumber } from 'bignumber.js';
import * as CryptoJS from 'crypto-js';
import * as fs from 'fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'fs';
import * as _ from 'lodash';
import * as path from 'path';
import { first } from 'rxjs/operators';
import * as WebSocket from 'ws';
import {
  broadcastLatest,
  broadCastTransactionPool,
  connectToPeers,
  getPeerConnections, handleBlockchainResponse, MessageType,
  peerMessageHandlers, state, validateChunkBlocks
} from './p2p';
import {
  getFigBaseTransaction, isValidAddress, processTransactions, Transaction, UnspentTxOut
} from './transaction';
import { addToTransactionPool, getTransactionPool, updateTransactionPool } from './transactionPool';
import FSUtil from './utils/file.util';
import {
  createFromWalletTransaction,
  createTransaction,
  findUnspentTxOuts,
  getBalance,
  getPrivateFromWallet,
  getPublicFromNodeWallet
} from './wallet';

import moment = require('moment');

const blockchainLocation = 'node/blockchain/';
const peers = require('../node/peers/peers.json');
const nodesecretlocation = process.env.NODE_SECRET_LOCATION || 'node/wallet/node_secret';

// in seconds
const BLOCK_GENERATION_INTERVAL: number = 8;
// in blocks
const DIFFICULTY_ADJUSTMENT_INTERVAL: number = 10;
// min figing
const MIN_COIN_FOR_FIGING: number = 100000;

const BLOCKCHAIN_CHUNK_SIZE: number = 10000;

class Block {

  public index: number;
  public hash: string;
  public previousHash: string;
  public timestamp: number;
  public data: Transaction[];
  public difficulty: number;
  public figerBalance: number;
  public figerAddress: string;

  constructor(index: number, hash: string, previousHash: string,
    timestamp: number, data: Transaction[], difficulty: number, figerBalance: number, figerAddress: string) {
    this.index = index;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.data = data;
    this.hash = hash;
    this.difficulty = difficulty;
    this.figerBalance = figerBalance;
    this.figerAddress = figerAddress;
  }
}

const genesisTransaction = {
  'txIns': [{ 'signature': '', 'txOutId': '', 'txOutIndex': 0 }],
  'txOuts': [{
    'address': 'tWzTTAFzNgGibTwPLSNxvEDVAAwKV9zPGdVzuyPvRWVn',
    'amount': 1
  }, {
    'address': 'tWzTTAFzNgGibTwPLSNxvEDVAAwKV9zPGdVzuyPvRWVn',
    'amount': 10000000
  }, {
    'address': '29zJUEdSeGESDf7NHXE5mDgg7WkHkcA2YqwGS9eYHG2yb',
    'amount': 10000000
  }, {
    'address': '27pTrhEEU1qJjD8KCXa1h4JZ8stAsZMagsmDjkwxVibns',
    'amount': 10000000
  }, {
    'address': '22PYANdRGoJ5GnfAGS3QJjn2u1pG1mhGrksPbdQYaqyyV',
    'amount': 1000000
  }],
  'id': 'a7998df5379f3133ec48b75b0db533d3b0e784ede170f2e09da42c38e9494828'
};

const genesisBlock: Block = new Block(
  0, 'daf7a68e52b35ec1e00f68e137ce7b7609dca13f6ffd5f324f6d4b3df96bc3f5', '', 734994001, [genesisTransaction], 0, 0, 'tWzTTAFzNgGibTwPLSNxvEDVAAwKV9zPGdVzuyPvRWVn'
);

let unspentTxOuts: UnspentTxOut[] = processTransactions(genesisBlock.data, [], 0);

const searchBlockchain = (condition, onlyFirstOccurence = false): Block[] => {
  const bgs = blockGroups();
  const bgsKeys = Object.keys(bgs);

  const result = [];
  for (let i = 0; i < bgsKeys.length; i++) {
    const bg = bgsKeys[i];
    const chunkBlocks = getBlockchainChunk(bg);

    const filteredBlocks = chunkBlocks.filter(condition);
    if (filteredBlocks.length) {
      result.push(...filteredBlocks);

      if (onlyFirstOccurence) {
        break;
      }
    }
  }

  return result;
};

const getBlockchainChunk = (index: string): Block[] => {
  const bgs = blockGroups();
  if (!bgs[index]) {
    console.error('Block Group Not Found!');
    // process.exit(1);
    return null;
  }

  return readBlockchainAt(index);
};

const readBlockchainAt = (index: string): Block[] => {
  console.log("index", index)
  const blockPath: string = path.join(blockchainLocation, index);
  if (!fs.existsSync(blockPath)) {
    console.error(`Block Path Not Found: ${blockPath}`);
    process.exit(1);
  }

  const blocks: number[] = FSUtil.getFiles(blockPath).map((bn) => +bn).sort((a, b) => a > b ? 1 : -1);
  const blockResponse: Block[] = [];
  blocks.forEach((block) => {
    let blockData: string | Block = fs.readFileSync(path.join(blockPath, block.toString())).toString('utf-8');

    try {
      blockData = JSON.parse(blockData);
    } catch (e) {
      console.error(`Corrupted Block Data: ${index} - ${block}`);
      process.exit(1);
    }

    blockResponse.push(blockData as Block);
  });
  return blockResponse;
}

const getLastNBlockchainChunk = (n: number): Block[] => {
  const bgs = blockGroups();

  const bgsKeys = Object.keys(bgs);
  if (!bgsKeys.length) {
    console.error('No Block Group!');
    process.exit(1);
  }

  const orderedGroups = bgsKeys.sort((a, b) => a > b ? 1 : -1);

  const blocks = [];
  const filteredGroups = orderedGroups.slice(orderedGroups.length - n);

  for (let i = 0; i < filteredGroups.length; i++) {

    const fg = filteredGroups[i];
    const blks: Block[] = readBlockchainAt(fg);
    blocks.push(...blks);
  }

  return blocks;
};

const blockGroups = () => {
  /*const dates = FSUtil.getDirectories(blockchainLocation)
    .sort((a, b) => a > b ? 1 : -1);*/

  const groups: { [key: string]: number } = {};

  const dates = FSUtil.getDirectories(blockchainLocation);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    groups[date] = FSUtil.getFiles(path.join(blockchainLocation, date)).length;
  }

  return groups;
};

const getBlockchainWithOffset = (
  offset: number,
  page: number
): { blocks: Block[]; totalBlocksSize: number } => {
  const lastBlock: Block = getLatestBlock();
  const totalBlocksSize: number = lastBlock.index + 1;

  const blockHeight = lastBlock.index;

  const startIndex = blockHeight + 1 - (offset * page);

  const offsetBlock = getBlockGroupIndex(startIndex);
  const nextBlock = getBlockGroupIndex(startIndex + page);

  const virtualStartIndex = startIndex - (Math.floor(startIndex / BLOCKCHAIN_CHUNK_SIZE) * BLOCKCHAIN_CHUNK_SIZE);
  const virtualEndIndex = virtualStartIndex + page;

  const offsetBlocks: Block[] = getBlockchainChunk(offsetBlock.toString());

  let blocks = [];
  if (offsetBlock !== nextBlock) {
    const nextOffsetBlocks: Block[] = getBlockchainChunk(nextBlock.toString());
    offsetBlocks.push(...nextOffsetBlocks);
  }

  const tbs: Block[] = offsetBlocks.slice(virtualStartIndex, virtualEndIndex);
  blocks.push(...tbs);

  blocks = blocks.sort((a, b) => b.index - a.index);

  return { blocks, totalBlocksSize };
};

const getNodeUnspentTxOuts = (): UnspentTxOut[] => _.cloneDeep(unspentTxOuts);

const setUnspentTxOuts = (newUnspentTxOut: UnspentTxOut[]) => {
  unspentTxOuts = newUnspentTxOut;
};

// const getLatestBlock = (): Block => blockchain[blockchain.length - 1];

const sBlocks = { latest: genesisBlock };
const getLatestBlock = (): Block => sBlocks.latest;
const setLatestBlock = (block: Block) => sBlocks.latest = block;

const getDifficulty = (): number => {
  const latestBlock: Block = getLatestBlock();
  if (latestBlock.index % DIFFICULTY_ADJUSTMENT_INTERVAL === 0 && latestBlock.index !== 0) {
    return getAdjustedDifficulty(latestBlock);
  } else {
    return latestBlock.difficulty;
  }
};

const getAdjustedDifficulty = (latestBlock: Block) => {
  const bchain = getLastNBlockchainChunk(2);
  console.log(bchain, "xxx")

  const prevAdjustmentBlock: Block = bchain[bchain.length - DIFFICULTY_ADJUSTMENT_INTERVAL];

  const timeExpected: number = BLOCK_GENERATION_INTERVAL * DIFFICULTY_ADJUSTMENT_INTERVAL;
  const timeTaken: number = latestBlock.timestamp - prevAdjustmentBlock.timestamp;

  if (timeTaken < timeExpected / 2) {
    return prevAdjustmentBlock.difficulty + 1;
  } else if (timeTaken > timeExpected * 2) {
    if (prevAdjustmentBlock.difficulty <= 0) {
      return 0;
    } else {
      return prevAdjustmentBlock.difficulty - 1;
    }
  } else {
    return prevAdjustmentBlock.difficulty;
  }
};

const getCurrentTimestamp = (): number => Math.round(new Date().getTime() / 1000);

const generateFigNextBlock = (blockData: Transaction[]) => {
  const previousBlock: Block = getLatestBlock();
  const difficulty: number = getDifficulty();
  const nextIndex: number = previousBlock.index + 1;
  const newBlock: Block = findBlock(nextIndex, previousBlock.hash, blockData, difficulty);

  if (newBlock === null) {
    console.log('Node has not enough money to mine this block');
    return null;
  } else {
    if (addBlockToChain(newBlock)) {
      setLatestBlock(newBlock);
      broadcastLatest();
      return newBlock;
    } else {
      console.log('error');
      return null;
    }
  }

};

const getMyUnspentTransactionOutputs = () => {
  return findUnspentTxOuts(getPublicFromNodeWallet(), getNodeUnspentTxOuts());
};

const generateNextBlock = () => {
  const coinbaseTx: Transaction = getFigBaseTransaction(getPublicFromNodeWallet(), getLatestBlock().index + 1);
  const blockData: Transaction[] = [coinbaseTx].concat(getTransactionPool());
  return generateFigNextBlock(blockData);
};

const generateNextBlockWithTransaction = (receiverAddress: string, amount: number, nodeSecret: string) => {
  const nodeSecretKey = readFileSync(nodesecretlocation, 'utf8').toString();
  if (nodeSecretKey !== nodeSecret) {
    throw Error('Invalid node secret');
  }

  if (!isValidAddress(receiverAddress)) {
    throw Error('Invalid address format');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    throw Error('Invalid coin amount');
  }

  const tx: Transaction = createTransaction(receiverAddress, amount, getPrivateFromWallet(), getNodeUnspentTxOuts(), getTransactionPool());
  const coinbaseTx: Transaction = getFigBaseTransaction(getPublicFromNodeWallet(), getLatestBlock().index + 1);
  const blockData: Transaction[] = [coinbaseTx, tx];
  return generateFigNextBlock(blockData);
};

const findBlock = (index: number, previousHash: string, data: Transaction[], difficulty: number): Block => {
  let pastTimestamp: number = 0;
  while (true) {
    const timestamp: number = getCurrentTimestamp();
    if (pastTimestamp !== timestamp) {
      if (getNodeBalance() <= MIN_COIN_FOR_FIGING) {

        return null;
      } else {
        const hash: string = calculateHash(index, previousHash, timestamp, data, difficulty, getNodeBalance(), getPublicFromNodeWallet());
        if (isBlockStakingValid(previousHash, getPublicFromNodeWallet(), timestamp, getNodeBalance(), difficulty, index)) {
          return new Block(index, hash, previousHash, timestamp, data, difficulty, getNodeBalance(), getPublicFromNodeWallet());
        }
        pastTimestamp = timestamp;
      }
    }
  }
};

const getNodeBalance = (): number => {
  return getBalance(getPublicFromNodeWallet(), getNodeUnspentTxOuts());
};

const getFreeWalletBalance = (address: string): number => {
  return getBalance(address, getNodeUnspentTxOuts());
};

const sendTransactionToPool = (address: string, amount: number, nodeSecret: string): Transaction => {
  const nodeSecretKey = readFileSync(nodesecretlocation, 'utf8').toString();
  if (nodeSecretKey !== nodeSecret) {
    throw Error('Invalid node secret');
  }

  const tx: Transaction = createTransaction(address, amount, getPrivateFromWallet(), getNodeUnspentTxOuts(), getTransactionPool());
  addToTransactionPool(tx, getNodeUnspentTxOuts());
  broadCastTransactionPool();
  return tx;
};

const sendFromWalletTransactionToPool = (publicKey: string, privateKey: string, toPublicKey: string, amount: number): Transaction => {

  const tx: Transaction = createFromWalletTransaction(publicKey, amount, privateKey, toPublicKey, getNodeUnspentTxOuts(), getTransactionPool());
  addToTransactionPool(tx, getNodeUnspentTxOuts());
  broadCastTransactionPool();
  return tx;
};

const calculateHashForBlock = (block: Block): string =>
  calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.difficulty, block.figerBalance, block.figerAddress);

const calculateHash = (index: number, previousHash: string, timestamp: number, data: Transaction[],
  difficulty: number, figerBalance: number, figerAddress: string): string => {
  const firstHash = CryptoJS.SHA512(index + previousHash + timestamp + data + difficulty + figerBalance + figerAddress).toString();
  const doubledHash = CryptoJS.SHA256(firstHash).toString();
  return doubledHash;
};

const isValidBlockStructure = (block: Block): boolean => {
  return typeof block.index === 'number'
    && typeof block.hash === 'string'
    && typeof block.previousHash === 'string'
    && typeof block.timestamp === 'number'
    && typeof block.data === 'object'
    && typeof block.difficulty === 'number'
    && typeof block.figerBalance === 'number'
    && typeof block.figerAddress === 'string';
};

const isValidNewBlock = (newBlock: Block, previousBlock: Block): boolean => {
  if (!isValidBlockStructure(newBlock)) {
    console.log('Invalid structure: %s', JSON.stringify(newBlock));
    return false;
  }
  if (!isValidFiger(newBlock.data)) {
    console.log('Invalid Node Balance');
    return false;
  }
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log('Invalid Index');
    return false;
  } else if (previousBlock.hash !== newBlock.previousHash) {
    console.log('Invalid Previoushash');
    return false;
  } else if (!isValidTimestamp(newBlock.timestamp, previousBlock.timestamp)) {
    console.log('Invalid Timestamp');
    return false;
  } else if (!hasValidHash(newBlock)) {
    return false;
  }
  return true;
};

const isValidTimestamp = (newTimestamp: number, previousTimestamp: number): boolean => {
  return (previousTimestamp - 60 < newTimestamp)
    && newTimestamp - 60 < getCurrentTimestamp();
};

const isValidFiger = (transactions: Transaction[]): boolean => {
  return getBalance(transactions[0].txOuts[0].address, getNodeUnspentTxOuts()) >= MIN_COIN_FOR_FIGING;
};

const hasValidHash = (block: Block): boolean => {

  if (!hashMatchesBlockContent(block)) {
    console.log('invalid hash, got:' + block.hash);
    return false;
  }

  if (!isBlockStakingValid(block.previousHash, block.figerAddress, block.figerBalance, block.timestamp, block.difficulty, block.index)) {
    console.log('staking hash not lower than balance over diffculty times 2^256');
  }
  return true;
};

const hashMatchesBlockContent = (block: Block): boolean => {
  const blockHash: string = calculateHashForBlock(block);
  return blockHash === block.hash;
};

const isBlockStakingValid = (prevhash: string, address: string, timestamp: number, balance: number, difficulty: number, index: number): boolean => {
  difficulty = difficulty + 1;

  const balanceOverDifficulty = new BigNumber(2).exponentiatedBy(256).times(balance).dividedBy(difficulty);
  const stakingHash: string = CryptoJS.SHA256(prevhash + address + timestamp).toString();

  const decimalStakingHash = new BigNumber(stakingHash, 16);

  const difference = balanceOverDifficulty.minus(decimalStakingHash).toNumber();

  return difference >= 0;
};

const isValidChain = (blockchainToValidate: Block[]): UnspentTxOut[] => {
  console.log('isValidChain ?');

  const isValidGenesis = (block: Block): boolean => {
    return JSON.stringify(block) === JSON.stringify(genesisBlock);
  };

  if (blockchainToValidate[0].index === 0 && !isValidGenesis(blockchainToValidate[0])) {
    return null;
  }
  /*
  Tüm blockları valid mi kontrol ediyoruz.
   */

  const txOuts = { aUnspentTxOuts: [] };
  // let aUnspentTxOuts: UnspentTxOut[] = [];

  const bgs = blockGroups();
  const bgKeys = Object.keys(bgs).sort((a, b) => a > b ? 1 : -1);
  for (let i = 0; i < bgKeys.length; i++) {
    const blockGroup = bgKeys[i];
    const blocks: Block[] = getBlockchainChunk(blockGroup);
    if (!blocks) {
      return null;
    }

    const previousBlockGroup = bgKeys[i - 1];
    let previousChunkBlocks: Block[];
    if (i !== 0) {
      previousChunkBlocks = getBlockchainChunk(previousBlockGroup);
      if (!previousChunkBlocks) {
        return null;
      }
    }

    const isValid = isValidChunk(txOuts, blocks, previousChunkBlocks);
    if (null === isValid) {
      console.log('invalid transactions in blockchain');
      return null;
    }
  }

  // return txOuts.aUnspentTxOuts;

  for (let i = 0; i < blockchainToValidate.length; i++) {
    const currentBlock: Block = blockchainToValidate[i];

    if (currentBlock.index !== 0 && i !== 0 && !isValidNewBlock(blockchainToValidate[i], blockchainToValidate[i - 1])) {
      return null;
    }

    if (i === 0) {
      const block = blockchainToValidate[i];
      const previousBgIndex = (Math.floor(block.index / BLOCKCHAIN_CHUNK_SIZE)) * BLOCKCHAIN_CHUNK_SIZE;
      const previousChunkBlocks = getBlockchainChunk(previousBgIndex.toString());
      const previousBlock = previousChunkBlocks[previousChunkBlocks.length - 1];
      if (!isValidNewBlock(block, previousBlock)) {
        return null;
      }
    }

    txOuts.aUnspentTxOuts = processTransactions(currentBlock.data, txOuts.aUnspentTxOuts, currentBlock.index);
    if (txOuts.aUnspentTxOuts === null) {
      console.log('invalid transactions in blockchain');
      return null;
    }
  }

  return txOuts.aUnspentTxOuts;
};

const isValidChunk = (txOuts, currentChunk: Block[], previousChunk?: Block[]) => {
  for (let i = 0; i < currentChunk.length; i++) {
    const currentBlock: Block = currentChunk[i];

    if (currentBlock.index !== 0 && i !== 0 && !isValidNewBlock(currentChunk[i], currentChunk[i - 1])) {
      return null;
    }

    if (i === 0 && currentBlock.index !== 0) {
      const block = currentChunk[i];
      // const previousBgIndex = (Math.floor(block.index / BLOCKCHAIN_CHUNK_SIZE)) * BLOCKCHAIN_CHUNK_SIZE;
      // const previousChunkBlocks = getBlockchainChunk(previousBgIndex.toString());

      if (previousChunk) {
        const previousChunkBlocks = previousChunk;
        const previousBlock = previousChunkBlocks[previousChunkBlocks.length - 1];
        if (!isValidNewBlock(block, previousBlock)) {
          return null;
        }
      }
    }

    txOuts.aUnspentTxOuts = processTransactions(currentBlock.data, txOuts.aUnspentTxOuts, currentBlock.index);
    if (txOuts.aUnspentTxOuts === null) {
      console.log('invalid transactions in blockchain');
      return null;
    }
  }

  return txOuts.aUnspentTxOuts;
};

const addBlockToChain = (newBlock: Block): boolean => {
  if (isValidNewBlock(newBlock, getLatestBlock())) {
    const retVal: UnspentTxOut[] = processTransactions(newBlock.data, getNodeUnspentTxOuts(), newBlock.index);
    if (retVal === null) {
      console.log('block is not valid in terms of transactions');
      return false;
    } else {
      // blockchain.push(newBlock);
      setLatestBlock(newBlock);
      writeBlocksToFile(newBlock);
      setUnspentTxOuts(retVal);
      updateTransactionPool(unspentTxOuts);
      return true;
    }
  }
  return false;
};

const getBlockGroupIndex = (blockIndex: number) => {
  return (Math.floor(blockIndex / BLOCKCHAIN_CHUNK_SIZE) + 1) * BLOCKCHAIN_CHUNK_SIZE;
};

const writeBlocksToFile = (newBlock: Block): boolean => {
  // const time = moment(newBlock.timestamp * 1000).format('YYYYMMDD');

  const rangeEnd = getBlockGroupIndex(newBlock.index);
  const range = rangeEnd.toString();

  const bPath = `${blockchainLocation}/${range}`;
  if (!existsSync(bPath)) {
    mkdirSync(bPath);
  }
  writeFileSync(`${bPath}/${newBlock.index}`, JSON.stringify(newBlock));
  return true;
};

const replaceBlockhainToFileSystem = (newBlocks: Block[]): boolean => {
  for (let index = 0; index < newBlocks.length; index++) {
    const newBlock = newBlocks[index];
    writeBlocksToFile(newBlock);
  }
  return true;
};

const replaceChain = (newBlocks: Block[]) => {
  const aUnspentTxOuts = isValidChain(newBlocks);
  const validChain: boolean = aUnspentTxOuts !== null;

  if (validChain) {
    console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
    setUnspentTxOuts(aUnspentTxOuts);
    updateTransactionPool(unspentTxOuts);
    replaceBlockhainToFileSystem(newBlocks);
    broadcastLatest();
    setLatestBlock(newBlocks[newBlocks.length - 1]);

  } else {
    console.log('Received blockchain invalid');
  }
};

const initGenesis = () => {
  writeBlocksToFile(genesisBlock);
};

const syncChain = async () => {
  // Set latest block
  const latestBlocks = getLastNBlockchainChunk(1);
  setLatestBlock(latestBlocks[latestBlocks.length - 1]);

  const bgs = blockGroups();
  const bgKeys = Object.keys(bgs).sort((a, b) => a > b ? 1 : -1);
  for (let i = 0; i < bgKeys.length; i++) {
    const blockGroup = bgKeys[i];
    const blocks = getBlockchainChunk(blockGroup);

    const isValid = validateChunkBlocks(blocks);
    if (!isValid) {
      if (existsSync(blockchainLocation)) {
        rmdirSync(blockchainLocation, { recursive: true });
        mkdirSync(blockchainLocation);
      }

      writeBlocksToFile(genesisBlock);
      return await syncChain();
    }
  }

  // Wait for peers to sync
  const peerConnections = getPeerConnections();
  const pcs = Object.keys(peerConnections);
  for (let i = 0; i < pcs.length; i++) {
    const peerConnectionString = pcs[i];
    const syncRes = await syncPeer(peerConnectionString).catch((err) => {
      console.error('Peer Sync Error: ', err);
    });

    if (syncRes) {
      break;
    }
  }

  state.sync = true;

  return true;
};

const write = (ws: WebSocket, message: any): void => ws.send(JSON.stringify(message));

const syncPeer = (peerConnectionString: string) => {
  const peerConnections = getPeerConnections();
  const peerConnection: WebSocket = peerConnections[peerConnectionString];

  return new Promise(async (resolve, reject) => {
    if (peerConnection.readyState !== WebSocket.OPEN) {
      return reject(false);
    }

    // Get Latest BlockHeight
    write(peerConnection, { 'type': MessageType.QUERY_LATEST, 'data': null } as any);

    const queryLatestResponseStream = peerMessageHandlers[peerConnection.url][MessageType.RESPONSE_BLOCKCHAIN];
    const queryLatestData = await queryLatestResponseStream.pipe(first()).toPromise();

    // Compare Latest BlockHeight
    const latestBlock: Block = queryLatestData.data;
    if (latestBlock.index !== getLatestBlock().index) {
      // Sync Blocks
      write(peerConnection, { 'type': MessageType.QUERY_BLOCK_GROUPS, 'data': null } as any);

      const blockGroupResponseStream = peerMessageHandlers[peerConnection.url][MessageType.RESPONSE_BLOCK_GROUPS];
      const bgs = await blockGroupResponseStream.pipe(first()).toPromise();

      // Compare with Current Groups
      const currentBlockGroups = blockGroups();

      const bgKeys = Object.keys(bgs.data);
      for (let i = 0; i < bgKeys.length; i++) {
        const bg = bgKeys[i];
        if (!currentBlockGroups[bg] || currentBlockGroups[bg] !== bgs[bg]) {
          // Fetch Group
          write(peerConnection, { 'type': MessageType.QUERY_BLOCKCHAIN_CHUNK, data: bg } as any);

          const chunkBlockResponseStream = peerMessageHandlers[peerConnection.url][MessageType.RESPONSE_BLOCKCHAIN_CHUNK];
          const blocks = await chunkBlockResponseStream.pipe(first()).toPromise();
          handleBlockchainResponse(blocks.data);
        }
      }
    }

    resolve(true);
  });
};

const initConnections = () => {
  peers.map((item: string) => connectToPeers(item));
  console.log('peers added p2p port on: ' + peers);

};

const handleReceivedTransaction = (transaction: Transaction) => {
  addToTransactionPool(transaction, getNodeUnspentTxOuts());
};

export {
  Block,
  getBlockchainWithOffset,
  getNodeUnspentTxOuts,
  sendTransactionToPool,
  sendFromWalletTransactionToPool,
  generateFigNextBlock,
  generateNextBlock,
  generateNextBlockWithTransaction,
  getFreeWalletBalance,
  handleReceivedTransaction,
  getMyUnspentTransactionOutputs,
  initConnections,
  getLatestBlock,
  getNodeBalance,
  isValidBlockStructure,
  replaceChain,
  addBlockToChain,
  writeBlocksToFile,
  blockGroups,
  getBlockchainChunk,
  searchBlockchain,
  getLastNBlockchainChunk,
  setLatestBlock,
  initGenesis,
  syncChain,
  BLOCKCHAIN_CHUNK_SIZE
};
