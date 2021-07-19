import * as _ from "lodash";
import { Observable, Subject } from "rxjs";
import * as WebSocket from "ws";
import { Server } from "ws";

import {
  addBlockToChain,
  Block,
  blockGroups,
  getLatestBlock,
  handleReceivedTransaction,
  isValidBlockStructure,
  getBlockchainChunk,
  replaceChain,
  BLOCKCHAIN_CHUNK_SIZE,
} from "./blockchain";
import { Transaction } from "./transaction";
import { getTransactionPool } from "./transactionPool";

const sockets: WebSocket[] = [];

enum MessageType {
  QUERY_LATEST = 0,
  QUERY_ALL = 1,
  RESPONSE_BLOCKCHAIN = 2,
  QUERY_TRANSACTION_POOL = 3,
  RESPONSE_TRANSACTION_POOL = 4,
  QUERY_BLOCK_GROUPS = 5,
  RESPONSE_BLOCK_GROUPS = 6,
  QUERY_BLOCKCHAIN_CHUNK = 7,
  RESPONSE_BLOCKCHAIN_CHUNK = 8,
}

class Message {
  public type: MessageType;
  public data: any;
}

const initP2PServer = (p2pPort: number) => {
  const server: Server = new WebSocket.Server({ port: p2pPort });
  server.on("connection", (ws: WebSocket) => {
    initConnection(ws);
  });

  console.log("listening websocket p2p port on: " + p2pPort);
};

const getSockets = () => sockets;

const initConnection = (ws: WebSocket) => {
  for (let i = 0; i < sockets.length; i++) {
    const s = sockets[i];

    if (s.url === ws.url) {
      // Delete duplicated socket connections from array
      _.without(sockets, sockets[i]);
    }
    console.log(s.url);
  }

  sockets.push(ws);
  initMessageHandler(ws);
  initErrorHandler(ws);
  write(ws, queryChainLengthMsg());

  setTimeout(() => {
    broadcast(queryTransactionPoolMsg());
  }, 1000);
};

const JSONToObject = <T>(data: string): T => {
  try {
    return JSON.parse(data);
  } catch (e) {
    console.log(e);
    return null;
  }
};

const state = { sync: false };
const peerMessageHandlers: {
  [key: string]: { [command: string]: Subject<Message> };
} = {};
const initMessageHandler = (ws: WebSocket) => {
  createCommandSubjects(ws.url);

  ws.on("message", (data: string) => {
    try {
      const message: Message = JSONToObject<Message>(data);
      peerMessageHandlers[ws.url][message.type].next(message);

      if (!state.sync) {
        return;
      }

      if (message === null) {
        console.log("could not parse received JSON message: " + data);
        return;
      }
      console.log("Received message: %s", JSON.stringify(message));
      switch (message.type) {
        case MessageType.QUERY_LATEST:
          write(ws, responseLatestMsg());
          break;

        case MessageType.RESPONSE_BLOCKCHAIN: {
          const receivedBlocks: Block[] = JSONToObject<Block[]>(message.data);
          if (receivedBlocks === null) {
            console.log("invalid blocks received do nothing.");
            break;
          }
          handleBlockchainResponse(receivedBlocks);
          break;
        }

        case MessageType.QUERY_TRANSACTION_POOL:
          write(ws, responseTransactionPoolMsg());
          break;

        case MessageType.RESPONSE_TRANSACTION_POOL:
          const receivedTransactions: Transaction[] = JSONToObject<
            Transaction[]
          >(message.data);
          if (receivedTransactions === null) {
            console.log("invalid transaction received do nothing.");
            break;
          }
          receivedTransactions.forEach((transaction: Transaction) => {
            try {
              handleReceivedTransaction(transaction);
              broadCastTransactionPool();
            } catch (e) {
              console.log(e.message);
            }
          });
          break;

        case MessageType.QUERY_BLOCK_GROUPS:
          write(ws, {
            type: MessageType.RESPONSE_BLOCK_GROUPS,
            data: blockGroups(),
          });
          break;

        case MessageType.RESPONSE_BLOCK_GROUPS:
          const peerGroups = message.data;
          const currentGroups = blockGroups();

          const pgKeys = Object.keys(peerGroups);
          for (let i = 0; i < pgKeys.length; i++) {
            const pg = pgKeys[i];
            if (!currentGroups[pg] || currentGroups[pg] !== peerGroups[pg]) {
              // Fetch Group
              write(ws, { type: MessageType.QUERY_BLOCKCHAIN_CHUNK, data: pg });
            }
          }
          break;

        case MessageType.QUERY_BLOCKCHAIN_CHUNK: {
          const blockGroup = message.data;
          const blocks = getBlockchainChunk(blockGroup);
          if (!blocks.length) {
            console.log(`Blocks not found: ${blockGroup}`);
            break;
          }
          write(ws, {
            type: MessageType.RESPONSE_BLOCKCHAIN_CHUNK,
            data: blocks,
          });
          break;
        }

        case MessageType.RESPONSE_BLOCKCHAIN_CHUNK: {
          const receivedBlocks: Block[] = message.data;
          if (receivedBlocks === null) {
            console.log("invalid blocks received do nothing.");
            break;
          }
          handleBlockchainResponse(receivedBlocks);
          break;
        }
      }
    } catch (e) {
      console.log(e);
    }
  });
};

const createCommandSubjects = (peer: string) => {
  const commandsKeys = Object.keys(MessageType);
  commandsKeys.forEach((commandKey) => {
    const command = commandsKeys[commandKey];
    if (!peerMessageHandlers[peer]) {
      peerMessageHandlers[peer] = {};
    }

    peerMessageHandlers[peer][command] = new Subject();
  });
};

const write = (ws: WebSocket, message: Message): void =>
  ws.send(JSON.stringify(message));
const broadcast = (message: Message): void =>
  sockets.forEach((socket) => write(socket, message));

const queryChainLengthMsg = (): Message => ({
  type: MessageType.QUERY_LATEST,
  data: null,
});

const queryAllMsg = (): Message => ({
  type: MessageType.QUERY_BLOCK_GROUPS,
  data: null,
});

const responseLatestMsg = (): Message => ({
  type: MessageType.RESPONSE_BLOCKCHAIN,
  data: JSON.stringify([getLatestBlock()]),
});

const queryTransactionPoolMsg = (): Message => ({
  type: MessageType.QUERY_TRANSACTION_POOL,
  data: null,
});

const responseTransactionPoolMsg = (): Message => ({
  type: MessageType.RESPONSE_TRANSACTION_POOL,
  data: JSON.stringify(getTransactionPool()),
});

const initErrorHandler = (ws: WebSocket) => {
  const closeConnection = (myWs: WebSocket) => {
    console.log("connection failed to peer: " + myWs.url);
    sockets.splice(sockets.indexOf(myWs), 1);
  };
  ws.on("close", () => closeConnection(ws));
  ws.on("error", () => closeConnection(ws));
};

const handleBlockchainResponse = (receivedBlocks: Block[]) => {
  if (receivedBlocks.length === 0) {
    console.log("received block chain size of 0");
    return false;
  }
  const latestBlockReceived: Block = receivedBlocks[receivedBlocks.length - 1];
  if (!isValidBlockStructure(latestBlockReceived)) {
    console.log("block structuture not valid: ", latestBlockReceived);
    return false;
  }
  const latestBlockHeld: Block = getLatestBlock();
  if (latestBlockReceived.index > latestBlockHeld.index) {
    console.log(
      "blockchain possibly behind. We got: " +
        latestBlockHeld.index +
        " Peer got: " +
        latestBlockReceived.index
    );
    if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
      if (addBlockToChain(latestBlockReceived)) {
        broadcast(responseLatestMsg());
      }
    } else if (receivedBlocks.length === 1) {
      console.log("We have to query the chain from our peer");
      broadcast(queryAllMsg());
    } else {
      console.log("Received blockchain is longer than current blockchain");
      replaceChain(receivedBlocks);
    }
  } else {
    console.log(
      "Received blockchain is not longer than current blockchain. Do nothing"
    );
  }

  return true;
};

const validateChunkBlocks = (receivedBlocks: Block[]) => {
  if (receivedBlocks.length === 0) {
    console.log("received block chain size of 0");
    return false;
  }

  for (let i = 0; i < receivedBlocks.length; i++) {
    const block: Block = receivedBlocks[i];

    // Genesis Block
    if (block.index === 0) {
      continue;
    }

    let previousBlock: Block;
    if (i === 0 && block.index !== 0) {
      // Get Previous Chunk's Latest Block
      const previousBgIndex =
        Math.floor(block.index / BLOCKCHAIN_CHUNK_SIZE) * BLOCKCHAIN_CHUNK_SIZE;
      const previousChunkBlocks = getBlockchainChunk(
        previousBgIndex.toString()
      );
      if (!previousChunkBlocks) {
        return false;
      }

      previousBlock = previousChunkBlocks[previousChunkBlocks.length - 1];
    } else {
      previousBlock = receivedBlocks[i - 1];
    }

    if (!isValidBlockStructure(block)) {
      console.log("Block structure is not valid: ", block);
      return false;
    }

    if (previousBlock.hash !== block.previousHash) {
      console.log("Block hash is not valid: ", block.index);
      return false;
    }
  }

  return true;
};

const broadcastLatest = (): void => {
  broadcast(responseLatestMsg());
};

const peerConnections = {};
const getPeerConnections = () => {
  return peerConnections;
};

const connectToPeers = (newPeer: string): void => {
  const ws: WebSocket = new WebSocket(newPeer);
  ws.on("open", () => {
    initConnection(ws);
  });

  ws.on("error", () => {
    console.log("connection failed " + newPeer);
  });

  ws.onclose = function () {
    setTimeout(() => {
      connectToPeers(newPeer);
    }, 5000);
  };

  peerConnections[newPeer] = ws;
};

const broadCastTransactionPool = () => {
  broadcast(responseTransactionPoolMsg());
};

export {
  connectToPeers,
  broadcastLatest,
  broadCastTransactionPool,
  initP2PServer,
  getSockets,
  getPeerConnections,
  peerMessageHandlers,
  MessageType,
  handleBlockchainResponse,
  state,
  validateChunkBlocks,
};
