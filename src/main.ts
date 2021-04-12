import * as  bodyParser from 'body-parser';
import * as cors from 'cors';
import * as express from 'express';
import * as _ from 'lodash';
import {
  Block,
  generateNextBlock,
  generateNextBlockWithTransaction,
  getBlockchainWithOffset,
  getFreeWalletBalance,
  getLatestBlock,
  getMyUnspentTransactionOutputs,
  getNodeBalance,
  getNodeUnspentTxOuts,
  initConnections,
  initGenesis,
  searchBlockchain,
  sendFromWalletTransactionToPool,
  sendTransactionToPool,
  syncChain
} from './blockchain';

import { connectToPeers, getSockets, initP2PServer } from './p2p';
import { UnspentTxOut } from './transaction';
import { getTransactionPool } from './transactionPool';
import { getNewFreeWallet, getPublicFromNodeWallet, initMasterWallet } from './wallet';

const rateLimit: any = require('express-rate-limit');

const httpPort: number = parseInt(process.env.HTTP_PORT) || 3010;
const p2pPort: number = parseInt(process.env.P2P_PORT) || 6010;

//version 0.1
const initHttpServer = (myHttpPort: number) => {
  const app = express();
  app.use(bodyParser.json());
  app.use(cors());

  const rateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minutes
    max: 1000,
    message: 'Too many request created from this IP, please try again after an hour'
  });

  app.use((err, req, res, next) => {
    if (err) {
      res.status(400).send(err.message);
    }
  });

  app.get('/v2/version', rateLimiter, (req, res) => {
    res.status(200).send('Hello From FigChain 0.002.5');
  });

  app.get('/v2/lastBlock', rateLimiter, (req, res) => {
    res.status(200).send(getLatestBlock());
  });

  app.get('/v2/blocksOffset', rateLimiter, (req, res) => {
    const offest = Number(req.query.offset);
    const page = Number(req.query.page);

    if (!(offest > 0)) {
      return res.status(400).send('invalid_offest');
    }

    res.status(200).send(getBlockchainWithOffset(offest, page));
  });

  app.get('/v2/block/:hash', rateLimiter, (req, res) => {
    const blocks = searchBlockchain((blk) => blk.hash === req.params.hash, true);
    const block = blocks.length > 0 ? blocks[0] : null;
    res.status(200).send(block);
  });

  app.get('/v2/transaction/:id', rateLimiter, (req, res) => {
    // TODO: search and get tx data!

    const blocks = searchBlockchain((blk: Block) => {
      return blk.data.findIndex(tx => tx.id === req.params.id) !== -1;
    }, true);

    const block = blocks.length ? blocks[0] : null;
    if (block) {
      const tx = block.data.find(tx => tx.id === req.params.id);
      return res.status(200).send(tx);
    }

    return res.status(200).send(null);
  });

  app.get('/v2/address/:address', rateLimiter, (req, res) => {
    const unspentTxOuts: UnspentTxOut[] =
      _.filter(getNodeUnspentTxOuts(), (uTxO) => uTxO.address === req.params.address);
    res.status(200).send({ 'unspentTxOuts': unspentTxOuts });
  });

  app.get('/v2/balance', rateLimiter, (req, res) => {
    const balance: number = getNodeBalance();
    res.status(200).send({ 'balance': balance });
  });

  app.get('/v2/balance/:address', rateLimiter, (req, res) => {
    const balance: number = getFreeWalletBalance(req.params.address);
    res.status(200).send({ 'balance': balance });
  });

  app.get('/v2/address', rateLimiter, (req, res) => {
    const address: string = getPublicFromNodeWallet();
    res.status(200).send({ 'address': address });
  });

  app.get('/v2/freeWallet', rateLimiter, (req, res) => {
    const returnObject = { success: true, data: getNewFreeWallet() };
    res.status(200).send(returnObject);
  });

  app.post('/v2/figBlock', rateLimiter, (req, res) => {
    const newBlock: Block = generateNextBlock();
    if (newBlock === null || newBlock === undefined) {
      res.status(400).send('could not generate block');
    } else {
      res.status(200).send(newBlock);
    }

  });

  app.post('/v2/figTransaction', rateLimiter, (req, res) => {
    const { address, amount, key: nodeSecret } = req.body;

    try {
      const resp = generateNextBlockWithTransaction(address, amount, nodeSecret);
      res.status(200).send(resp);
    } catch (e) {
      console.log(e.message);
      res.status(400).send(e.message);
    }
  });

  app.get('/v2/transactionPool', rateLimiter, (req, res) => {
    res.status(200).send(getTransactionPool());
  });

  app.post('/v2/sendTransactionToPool', rateLimiter, (req, res) => {

    try {
      const { address, amount, key: nodeSecret } = req.body;

      if (address === undefined || amount === undefined) {
        throw Error('invalid address or amount');
      }
      const resp = sendTransactionToPool(address, amount, nodeSecret);
      res.status(200).send(resp);
    } catch (e) {
      console.log(e.message);
      res.status(400).send(e.message);
    }
  });

  app.post('/v2/sendFromWalletTransactionToPool', rateLimiter, (req, res) => {
    try {
      const { publicKey, privateKey, toPublicKey, amount } = req.body;

      if (publicKey === undefined || privateKey === undefined || amount === undefined || toPublicKey === undefined) {
        throw Error('invalid keys or amount');
      }

      const resp = sendFromWalletTransactionToPool(publicKey, privateKey, toPublicKey, amount);
      const newBlock: Block = generateNextBlock();

      if (newBlock === null || newBlock === undefined) {
        if (resp) {
          let returnObject = { success: true, msg: 'New Transaction Send To Pool', data: resp };
          res.status(200).send(returnObject);
        } else {
          let returnObject = { success: false, msg: 'Error when save Transaction.' };
          res.status(400).send(returnObject);
        }

      } else {
        let returnObject = { success: true, msg: 'New Block Generated', data: newBlock };
        res.status(200).send(returnObject);
      }

    } catch (e) {
      console.log(e.message);
      res.status(400).send(e.message);
    }
  });

  app.get('/v2/unspentTransactionOutputs', rateLimiter, (req, res) => {
    res.status(200).send(getNodeUnspentTxOuts());
  });

  app.get('/v2/myUnspentTransactionOutputs', rateLimiter, (req, res) => {
    res.status(200).send(getMyUnspentTransactionOutputs());
  });

  app.get('/v2/peers', rateLimiter, (req, res) => {
    res.status(200).send(getSockets().map((s: any) => s._socket.remoteAddress + ':' + s._socket.remotePort));
  });

  app.post('/v2/addPeer', rateLimiter, (req, res) => {
    connectToPeers(req.body.peer);
    res.status(200).send();
  });

  app.listen(myHttpPort, () => {
    console.log('Listening http on port: ' + myHttpPort);
  });
};

(async () => {
  initGenesis();
  initMasterWallet();

  initP2PServer(p2pPort);
  initConnections();

  await new Promise((resolve) => setTimeout(resolve, 5000));

  await syncChain();
  console.log("Chain Replaced Success Now Starting HTTP Server")

  initHttpServer(httpPort);
})();
