import { Keypair, Connection, TransactionInstruction } from '@solana/web3.js';
import {
  actions,
  sendTransactionWithRetry,
  placeBid,
  models,
  cache,
  TokenAccount,
  ensureWrappedAccount,
  toLamports,
  ParsedAccount,
  toPublicKey,
} from '@oyster/common';

import { AccountLayout, MintInfo } from '@solana/spl-token';
import { AuctionView } from '../hooks';
import BN from 'bn.js';
import { setupCancelBid } from './cancelBid';
import { QUOTE_MINT } from '../constants';
const { createTokenAccount } = actions;
const { approve } = models;

export async function sendPlaceBid(
  connection: Connection,
  wallet: any,
  bidderTokenAccount: string | undefined,
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  // value entered by the user adjust to decimals of the mint
  amount: number,
) {
  let signers: Keypair[][] = [];
  let instructions: TransactionInstruction[][] = [];
  let bid = await setupPlaceBid(
    connection,
    wallet,
    bidderTokenAccount,
    auctionView,
    accountsByMint,
    amount,
    instructions,
    signers,
  );

  await sendTransactionWithRetry(
    connection,
    wallet,
    instructions[0],
    signers[0],
    'single',
  );

  return {
    amount: bid,
  };
}

export async function setupPlaceBid(
  connection: Connection,
  wallet: any,
  bidderTokenAccount: string | undefined,
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  // value entered by the user adjust to decimals of the mint
  amount: number,
  overallInstructions: TransactionInstruction[][],
  overallSigners: Keypair[][],
): Promise<BN> {
  let signers: Keypair[] = [];
  let instructions: TransactionInstruction[] = [];
  let cleanupInstructions: TransactionInstruction[] = [];

  const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );

  const tokenAccount = bidderTokenAccount
    ? (cache.get(bidderTokenAccount) as TokenAccount)
    : undefined;
  const mint = cache.get(
    tokenAccount ? tokenAccount.info.mint : QUOTE_MINT,
  ) as ParsedAccount<MintInfo>;
  let lamports = toLamports(amount, mint.info) + accountRentExempt;

  let bidderPotTokenAccount: string;
  if (!auctionView.myBidderPot) {
    bidderPotTokenAccount = createTokenAccount(
      instructions,
      wallet.publicKey,
      accountRentExempt,
      toPublicKey(auctionView.auction.info.tokenMint),
      toPublicKey(auctionView.auction.pubkey),
      signers,
    ).toBase58();
  } else {
    bidderPotTokenAccount = auctionView.myBidderPot?.info.bidderPot;
    if (!auctionView.auction.info.ended()) {
      let cancelSigners: Keypair[][] = [];
      let cancelInstr: TransactionInstruction[][] = [];
      await setupCancelBid(
        auctionView,
        accountsByMint,
        accountRentExempt,
        wallet,
        cancelSigners,
        cancelInstr,
      );
      signers = [...signers, ...cancelSigners[0]];
      instructions = [...cancelInstr[0], ...instructions];
    }
  }

  const payingSolAccount = ensureWrappedAccount(
    instructions,
    cleanupInstructions,
    tokenAccount,
    wallet.publicKey,
    lamports + accountRentExempt * 2,
    signers,
  );

  const transferAuthority = approve(
    instructions,
    cleanupInstructions,
    toPublicKey(payingSolAccount),
    wallet.publicKey,
    lamports - accountRentExempt,
  );

  signers.push(transferAuthority);

  const bid = new BN(lamports - accountRentExempt);
  await placeBid(
    wallet.publicKey.toBase58(),
    payingSolAccount,
    bidderPotTokenAccount,
    auctionView.auction.info.tokenMint,
    transferAuthority.publicKey.toBase58(),
    wallet.publicKey.toBase58(),
    auctionView.auctionManager.vault,
    bid,
    instructions,
  );

  overallInstructions.push([...instructions, ...cleanupInstructions]);
  overallSigners.push(signers);
  return bid;
}
