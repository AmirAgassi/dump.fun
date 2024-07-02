import WebSocket from 'ws';
import { green, blue, magenta, yellow, red } from 'colorette';
import { exec } from 'child_process';
import { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    Transaction, 
    LAMPORTS_PER_SOL, 
    SYSVAR_RENT_PUBKEY, 
    Keypair, 
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    createAssociatedTokenAccountInstruction, 
    getAssociatedTokenAddress,
    getAccount,
    createCloseAccountInstruction
} from "@solana/spl-token";
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import BN from 'bn.js';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

// load config
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const idl = JSON.parse(fs.readFileSync('pump_idl.json', 'utf8'));

const connection = new Connection(config.chainstack.rpcUrl, {
    commitment: config.solana.commitment,
    maxSupportedTransactionVersion: config.solana.maxSupportedTransactionVersion
});

const privateKeyString = process.env.PRIVATE_KEY;
if (!privateKeyString) {
    throw new Error('Private key not found in environment variables');
}
const privateKeyArray = privateKeyString.split(',').map(num => parseInt(num.trim()));
const privateKeyUint8Array = new Uint8Array(privateKeyArray);
const wallet = Keypair.fromSecretKey(privateKeyUint8Array);

let associated_bonding_curve = null;
const PUMP_PROGRAM_ID = new PublicKey(config.publicKeys.pumpProgramId);
const GLOBAL_ADDRESS = new PublicKey(config.publicKeys.globalAddress);
const FEE_RECIPIENT = new PublicKey(config.publicKeys.feeRecipient);
const EVENT_AUTHORITY = new PublicKey(config.publicKeys.eventAuthority);

async function getSolBalance(publicKey) {
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
}

let initialBalance = await getSolBalance(wallet.publicKey);

async function updateAndPrintPerformance() {
    const currentBalance = await getSolBalance(wallet.publicKey);
    const overallProfit = currentBalance - initialBalance;

    console.log(green('\nOverall Performance:'));
    console.log(`Initial Balance: ${initialBalance} SOL`);
    console.log(`Current Balance: ${currentBalance} SOL`);
}

updateAndPrintPerformance();

async function findBondingCurveAddress(tokenMint) {
    console.log("Snooping for bonding curve in sigs...");
    const recentSignatures = await connection.getSignaturesForAddress(new PublicKey(tokenMint));
    for (let sigInfo of recentSignatures) {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: config.solana.maxSupportedTransactionVersion
        });
        if (!tx || !tx.meta || !tx.meta.innerInstructions) continue;

        for (let ix of tx.transaction.message.instructions) {
            if (ix.programId.toBase58() === config.publicKeys.pumpProgramId && ix.accounts.length === 14) {
                return ix.accounts[2];  
            }
        }
    }
    throw new Error("Couldn't find bonding curve address");
}

async function createAssociatedTokenAccountAndBuy(tokenAddress, amount, maxSolCost) {
    try {
        console.log('Starting createAssociatedTokenAccountAndBuy function');
        const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
        const program = new Program(idl, PUMP_PROGRAM_ID, provider);

        const mintPublicKey = new PublicKey(tokenAddress);

        const bondingCurveAddress = await findBondingCurveAddress(tokenAddress);
        console.log(`Found Bonding Curve Address: ${bondingCurveAddress.toBase58()}`);

        const associatedBondingCurve = associated_bonding_curve;
        console.log(`Derived Associated Bonding Curve Address: ${associatedBondingCurve.toBase58()}`);

        const userAta = await getAssociatedTokenAddress(
            mintPublicKey,
            wallet.publicKey,
            true,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        console.log(`Associated Token Address: ${userAta.toBase58()}`);

        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: config.transactions.computeUnitLimit, 
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: config.bot.buyPriorityRate,
        });
        const tx = new Transaction()
            .add(modifyComputeUnits)
            .add(addPriorityFee);

        const account = await connection.getAccountInfo(userAta);
        if (!account) {
            console.log('Creating associated token account');
            tx.add(
                createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    userAta,
                    wallet.publicKey,
                    mintPublicKey,
                    TOKEN_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                )
            );
        }

        console.log('Fetching bonding curve data');
        const bondingCurveData = await program.account.bondingCurve.fetch(bondingCurveAddress);
        const mintInfo = await connection.getParsedAccountInfo(mintPublicKey);

        const decimals = mintInfo.value?.data.parsed.info.decimals;

        const virtualTokenReserves = bondingCurveData.virtualTokenReserves.toNumber();
        const virtualSolReserves = bondingCurveData.virtualSolReserves.toNumber();

        const adjustedVirtualTokenReserves = virtualTokenReserves / (10 ** decimals);
        const adjustedVirtualSolReserves = virtualSolReserves / LAMPORTS_PER_SOL;

        const virtualTokenPrice = adjustedVirtualSolReserves / adjustedVirtualTokenReserves;
        const finalAmount = (amount / virtualTokenPrice) * (10 ** decimals);

        console.log(`Calculated final amount: ${finalAmount}`);

        console.log('Creating buy instruction');
        const buyIx = await program.methods.buy(
            new BN(Math.floor(finalAmount)),
            new BN(maxSolCost * LAMPORTS_PER_SOL),
        ).accounts({
            global: GLOBAL_ADDRESS,
            feeRecipient: FEE_RECIPIENT,
            mint: mintPublicKey,
            bondingCurve: bondingCurveAddress,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: userAta,
            user: wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: EVENT_AUTHORITY,
            program: PUMP_PROGRAM_ID,
        }).instruction();

        tx.add(buyIx);

        const currentBlockHeight = await connection.getBlockHeight(config.solana.commitment);
        tx.recentBlockhash = (await connection.getLatestBlockhash(config.solana.commitment)).blockhash;
        tx.lastValidBlockHeight = currentBlockHeight + config.bot.lastValidBlockHeightOffset;

        tx.feePayer = wallet.publicKey;

        const feeCalculator = await connection.getFeeForMessage(tx.compileMessage());
        const minFee = feeCalculator.value;

        const desiredFee = minFee * config.transactions.minFeeMultiplier;
        console.log(`Setting desired fee: ${desiredFee} lamports`);

        console.log('Signing the transaction');
        tx.sign(wallet);

        console.log('Sending transaction');
        const txid = await sendAndConfirmTransaction(connection, tx, [wallet], {
            skipPreflight: true,
            preflightCommitment: config.solana.commitment,
            commitment: config.solana.commitment,
        });

        console.log(`Transaction sent. Signature: ${txid}`);
        console.log(`Purchased approximately ${finalAmount / (10 ** decimals)} tokens. Check your wallet for the exact amount.`);
        return txid;
    } catch (error) {
        console.error('Error purchasing token:', error);
        if (error.logs) {
            console.error('Transaction logs:', error.logs);
        }
        
        console.log('Buy transaction failed. Attempting to close the associated token account...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            await closeAssociatedTokenAccount(tokenAddress, wallet);
        } catch (closeError) {
            console.error('Error closing associated token account:', closeError);
        }
        
        throw error;
    }
}

async function sellToken(tokenAddress, minSolOutput = 0.001) {
    const maxRetries = config.bot.maxRetries;
    const retryDelay = config.bot.retryDelay;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            console.log(`Sell attempt ${attempt + 1} for token address: ${tokenAddress}`);

            const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
            const program = new Program(idl, PUMP_PROGRAM_ID, provider);

            const mintPublicKey = new PublicKey(tokenAddress);
            const bondingCurveAddress = await findBondingCurveAddress(tokenAddress);
            const associatedBondingCurve = associated_bonding_curve;

            const associatedTokenAddress = await getAssociatedTokenAddress(
                mintPublicKey,
                wallet.publicKey,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            console.log(`Associated Token Account: ${associatedTokenAddress.toBase58()}`);

            let tokenAccount;
            try {
                tokenAccount = await getAccount(connection, associatedTokenAddress);
            } catch (error) {
                console.log(`Error getting token account: ${error.message}`);
                if (error.message.includes('TokenAccountNotFound')) {
                    console.log(`Token account not found. Waiting for ${retryDelay}ms before retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                throw error;
            }

            console.log(`Token account info: ${JSON.stringify(tokenAccount, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            )}`);

            const tokenAmount = new BN(tokenAccount.amount.toString());
            console.log(`Token amount: ${tokenAmount.toString()}`);

            if (tokenAmount.isZero()) {
                console.log('Token account has zero balance. Skipping sell.');
                return null;
            }

            const minSolOutputLamports = new BN(minSolOutput * LAMPORTS_PER_SOL);

            const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
                units: config.transactions.computeUnitLimit, 
            });
            const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: config.bot.sellPriorityRate,
            });
            const tx = new Transaction()
                .add(modifyComputeUnits)
                .add(addPriorityFee);

            const sellIx = await program.methods.sell(tokenAmount, minSolOutputLamports)
                .accounts({
                    global: GLOBAL_ADDRESS,
                    feeRecipient: FEE_RECIPIENT,
                    mint: mintPublicKey,
                    bondingCurve: bondingCurveAddress,
                    associatedBondingCurve: associatedBondingCurve,
                    associatedUser: associatedTokenAddress,
                    user: wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    eventAuthority: EVENT_AUTHORITY,
                    program: PUMP_PROGRAM_ID,
                })
                .instruction();
            tx.add(sellIx);
            tx.recentBlockhash = (await connection.getLatestBlocktx.add(sellIx));
            tx.recentBlockhash = (await connection.getLatestBlockhash(config.solana.commitment)).blockhash;

            tx.feePayer = wallet.publicKey;

            const feeCalculator = await connection.getFeeForMessage(tx.compileMessage());
            const minFee = feeCalculator.value;

            const desiredFee = minFee * config.transactions.minFeeMultiplier;
            console.log(`Setting desired fee: ${desiredFee} lamports`);

            console.log('Signing the transaction');
            tx.sign(wallet);

            console.log('Sending sell transaction');
            const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
                skipPreflight: true,
                preflightCommitment: config.solana.commitment,
                commitment: config.solana.commitment,
            });

            console.log(`Sell transaction successful. Signature: ${signature}`);
            console.log(`Sold tokens. Check your wallet for the exact amount of SOL received.`);

            return signature;
        } catch (error) {
            console.error(`Error selling token on attempt ${attempt + 1}:`, error);
            console.error('Error stack:', error.stack);
            if (attempt < maxRetries - 1) {
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                console.error('Max retries reached. Unable to sell token.');
                throw error;
            }
        }
    }
}

let ws;
let isProcessingCoin = false;

function startWebSocket() {
    ws = new WebSocket(config.chainstack.wsUrl);

    ws.on('open', function open() {
        console.log('WebSocket is open');
        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                {
                    mentions: [config.publicKeys.pumpProgramId]
                },
                {
                    commitment: config.solana.commitment
                }
            ]
        };
        ws.send(JSON.stringify(request));
    });

    ws.on('message', async function incoming(data) {
        if (isProcessingCoin) return;

        const receiveTime = Date.now();
        const message = JSON.parse(data);
        if (message.method === 'logsNotification') {
            const transaction = message.params.result;
            const signature = transaction.value.signature;

            const logs = transaction.value.logs || [];
            const isMintTransaction = logs.some(log => log.includes('Program log: Instruction: SetAuthority'));

            if (!isMintTransaction) {
                return;
            }

            const timestamp = new Date(receiveTime).toISOString();
            console.log(`${timestamp} - Mint transaction detected: ${signature}`);
            try {
                await processNewToken(signature, receiveTime);
            } catch (error) {
                console.error('Error processing new token:', error);
            }
        }
    });

    ws.on('error', function error(err) {
        console.error('WebSocket error:', err);
    });

    ws.on('close', function close() {
        console.log('WebSocket connection closed');
        setTimeout(startWebSocket, 5000);
    });
}

async function closeAssociatedTokenAccount(tokenAddress, wallet) {
    const tokenMintPublicKey = new PublicKey(tokenAddress);

    try {
        const associatedTokenAddress = await getAssociatedTokenAddress(
            tokenMintPublicKey,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        console.log(`Associated Token Account to close: ${associatedTokenAddress.toBase58()}`);

        try {
            await getAccount(connection, associatedTokenAddress);
        } catch (error) {
            if (error.message.includes('TokenAccountNotFound')) {
                console.log('Token account already closed or does not exist. Skipping close operation.');
                return null;
            }
            throw error;
        }

        const closeInstruction = createCloseAccountInstruction(
            associatedTokenAddress,
            wallet.publicKey,
            wallet.publicKey,
            [],
            TOKEN_PROGRAM_ID
        );

        const transaction = new Transaction().add(closeInstruction);

        transaction.recentBlockhash = (await connection.getLatestBlockhash(config.solana.commitment)).blockhash;
        transaction.feePayer = wallet.publicKey;

        transaction.sign(wallet);

        const txid = await sendAndConfirmTransaction(connection, transaction, [wallet], {
            skipPreflight: false,
            commitment: config.solana.commitment,
        });

        console.log(`Transaction to close ATA sent. Signature: ${txid}`);
        console.log(`Closed ATA: ${associatedTokenAddress.toBase58()}`);
        return txid;
    } catch (error) {
        console.error('Error closing associated token account:', error);

        if (error.message.includes('AccountNotFound') || error.message.includes('TokenAccountNotFound')) {
            console.log('Account already closed or does not exist. Continuing...');
            return null;
        }
        throw error;
    }
}

async function processNewToken(transactionId, receiveTime) {
    if (isProcessingCoin) return;
    isProcessingCoin = true;
    ws.close();

    const maxRetries = config.bot.maxRetries;
    const retryDelay = config.bot.retryDelay;
    let tokenAddress = null;

    try {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Attempt ${attempt + 1}: Fetching transaction ${transactionId}`);

                const transaction = await connection.getTransaction(transactionId, {
                    commitment: config.solana.commitment,
                    maxSupportedTransactionVersion: config.solana.maxSupportedTransactionVersion
                });

                if (!transaction) {
                    console.log(`Attempt ${attempt + 1}: Transaction not found, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                console.log('Transaction found, processing...');

                const { meta, transaction: tx, blockTime, slot } = transaction;
                const solBalanceChange = meta.postBalances[0] - meta.preBalances[0];
                const tokenBalanceChange = meta.postTokenBalances.map((balance, index) => {
                    return {
                        mint: balance.mint,
                        amount: parseFloat(balance.uiTokenAmount.uiAmount),
                        account: balance.owner,
                    };
                });
                tokenAddress = tokenBalanceChange[0]?.mint || 'N/A';
                const ownerAccount = tokenBalanceChange.find(balance => balance.account !== "44ayC6Xbssroo1JhMCsfAgR9UkYnruiWu3Yv4XQF3G7z");
                const fixedAccount = tokenBalanceChange.find(balance => balance.account === "44ayC6Xbssroo1JhMCsfAgR9UkYnruiWu3Yv4XQF3G7z");

                const staticAccountKeys = transaction.transaction.message.staticAccountKeys;
                const specificPosition = 4; 
                console.log("Static Account Keys Amount:", staticAccountKeys.length)
                if (staticAccountKeys.length > specificPosition) {
                    associated_bonding_curve = staticAccountKeys[specificPosition];
                } else {
                    console.error("The staticAccountKeys array is shorter than expected.");
                } 
                console.log("Associated Bonding Curve Fast-Identified.");
                const totalTokens = tokenBalanceChange.reduce((sum, balance) => sum + balance.amount, 0);
                const ownerTokens = ownerAccount ? ownerAccount.amount : 0;
                const ownerPercentage = ownerTokens / totalTokens * 100;

                const signer = tx.signatures[0];
                const fee = meta.fee / LAMPORTS_PER_SOL;
                const result = meta.err === null ? 'Success' : 'Failure';
                const timestamp = new Date(blockTime * 1000);
                const block = slot;

                const now = Date.now();
                const analysisLatencyMs = now - receiveTime;
                const analysisLatency = new Date(analysisLatencyMs).toISOString().substr(11, 12);
                const totalLatencyMs = now - timestamp.getTime();
                const totalLatency = new Date(totalLatencyMs).toISOString().substr(11, 12);

                console.log(green(`Timestamp: ${timestamp.toISOString()}`));
                console.log(blue(`Signature: ${signer}`));
                console.log(magenta(`Analysis Latency: ${analysisLatency}`));
                console.log(magenta(`Total Latency: ${totalLatency}`));
                console.log(yellow(`Token Address: ${tokenAddress}`));
                console.log(`Liquidity Added: ${Math.abs(solBalanceChange / LAMPORTS_PER_SOL)} SOL`);
                console.log(`Block: #${block}`);
                console.log(`Result: ${result}`);
                console.log(`Fee: ${fee} SOL`);
                console.log(`Total Tokens: ${totalTokens}`);
                console.log(`Owner Tokens: ${ownerTokens} (${ownerPercentage.toFixed(2)}%)`);
                console.log(red('-------------------------'));

                if (Math.abs(solBalanceChange / LAMPORTS_PER_SOL) < config.bot.liquidityThreshold) {
                    console.log(red(`Liquidity is less than ${config.bot.liquidityThreshold} SOL. Skipping purchase, but continuing to scan for new coins.`));
                    break; 
                }

                if (totalLatencyMs > config.bot.totalLatencyThreshold) {
                    console.log(red(`Total latency exceeds ${config.bot.totalLatencyThreshold}ms. Skipping purchase, but continuing to scan for new coins.`));
                    break; 
                }

                if (tokenAddress !== 'N/A') {
                    try {
                        const buyPromise = createAssociatedTokenAccountAndBuy(tokenAddress, config.bot.amountToBuy, config.bot.maxSolCost);

                        const websiteUrl = `${config.bot.websiteUrl}${tokenAddress}`;
                        const command = process.platform === 'win32' ? `start ${websiteUrl}` : `open ${websiteUrl}`;
                        exec(command, (error) => {
                            if (error) {
                                console.error(`Error opening URL: ${error}`);
                            } else {
                                console.log(`Opened browser with URL: ${websiteUrl}`);
                            }
                        });

                        const buySignature = await buyPromise;
                        if (!buySignature) {
                            console.log('Purchase was skipped. Continuing to scan for new coins.');
                            return;
                        }
                        console.log(`Buy transaction signature: ${buySignature}`);

                        console.log(`Waiting for ${config.bot.timeToDump} milliseconds before attempting to sell...`);
                        await new Promise(resolve => setTimeout(resolve, config.bot.timeToDump));
                        
                        const sellSignature = await sellToken(tokenAddress);
                        if (sellSignature) {
                            console.log(`Sell transaction signature: ${sellSignature}`);

                            console.log('Waiting for 4 seconds before attempting to close the account...');
                            await new Promise(resolve => setTimeout(resolve, 4000));

                            await closeAssociatedTokenAccount(tokenAddress, wallet);
                        } else {
                            console.log('Sell operation was skipped.');
                        }
                    } catch (error) {
                        console.error('Error during purchase or sell process:', error);
                    }
                } else {
                    console.log('Invalid token address. Skipping purchase step.');
                }

                break; 
            } catch (error) {
                console.error(`Attempt ${attempt + 1}: Error processing new token:`, error);
                if (attempt === maxRetries - 1) {
                    console.error('Max retries reached. Unable to process new token.');
                } else {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
        updateAndPrintPerformance();
    } finally {
        isProcessingCoin = false;
        startWebSocket(); 
    }
}

console.log('Bot is running. Waiting for new token mints...');
startWebSocket();