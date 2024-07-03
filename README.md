# dump.fun

## Overview

dump.fun is an advanced, open-source memecoin launch sniping script designed for the Solana blockchain. It uses a reverse-engineered pump.fun program IDL and RPC node support to automate the process of detecting, purchasing, and selling newly launched memecoins on pump.fun.

## Support

If you like this project, please consider supporting it by giving a ⭐️ !

## Purpose

The primary purpose of this bot is to capitalize on the initial price surge that often happens immediately after a new memecoin is launched on pump.fun. By quickly detecting new token launches, purchasing tokens, and then selling them shortly after, the bot aims to generate profit from these rapid price movements.

## Why dump.fun?

While commercial memecoin sniping bots can cost anywhere from ~$50-2000, dump.fun offers a free, open-source alternative that puts control back in your hands. For simple RPC bots, the prices commonly charged at the moment are pretty insane.

![](https://i.imgur.com/TI0hZYS.png)

## How It Works

The dump.fun bot operates through a series of steps:

1. **WebSocket Connection**: 
   - The bot establishes a WebSocket connection to a Solana RPC node.
   - It subscribes to logs that mention the pump.fun program ID (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P).
   - This subscription allows the bot to receive real-time notifications of all transactions involving the pump.fun program.

2. **Transaction Detection and Analysis**:
   - When a new transaction is created, it's logs are scanned to identify specific patterns indicative of a new token launch.
   - Once a potential new token launch is detected, the bot fetches the full transaction details using the `getTransaction` method.

3. **Token Data Extraction**:
   - From the transaction details, the bot extracts crucial information:
     - Token Mint Address: The unique identifier for the new token.
     - Liquidity Added: The amount of SOL added as initial liquidity.
     - Token Balances: The distribution of tokens between the creator and the liquidity pool.
   - The bot also identifies the associated bonding curve address at a specific offset in the transaction's static account keys.
     - This is done to avoid buying into "scam" coins that include purchases of the coin by the dev from their own coin creation transaction, the wrong associated bonding curve will be identified in those cases and the buy transaction will fail (not the smartest implementation, but it works!)

4. **Validation and Decision Making**:
   - The bot performs several validation checks:
     - Liquidity Threshold: Ensures the added liquidity meets a minimum threshold (configurable).
     - Latency Check: Verifies that the total time since the transaction was confirmed is within acceptable limits.

5. **Token Purchase**:
   - If all criteria are met, the bot calculates the amount of tokens to buy based on the configuration and sends the transaction.

6. **Monitoring and Selling**:
   - After purchasing, the bot waits for a configurable amount of time.
   - It then attempts to sell the tokens, aiming to capitalize on any price increase.

7. **Account Cleanup**:
   - After selling, the bot attempts to close the associated token account to recover rent.

8. **Performance Tracking**:
   - The bot keeps track of overall performance, including initial and current balance.

## Setup and Usage

1. Clone the repository:
   ```
   git clone https://github.com/AmirAgassi/dump.fun.git
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure the bot:
   - Edit `config.json` to set your desired parameters (RPC URLs, thresholds, etc.)

4. Set up environment variables:
   - Create a `.env` file
   - Add your Solana wallet private key: `PRIVATE_KEY=your_private_key_here`

5. Run the bot:
   ```
   node index.js
   ```

## Configuration Options

The `config.json` file allows you to customize various aspects of the bot's behavior:

- `chainstack.rpcUrl`: URL for the Solana RPC node
- `chainstack.wsUrl`: WebSocket URL for real-time updates
- `bot.liquidityThreshold`: Minimum liquidity required to consider a token
- `bot.amountToBuy`: Amount of tokens to purchase
- `bot.maxSolCost`: Maximum SOL to spend on a single purchase
- `bot.timeToDump`: Time to wait before selling tokens (in milliseconds)
- ... (and many more options)

## RPC Node Requirements

The bot is designed to run optimally with a local Solana RPC node for the lowest latency. However, if a local node is not available, I recommend using the following providers:

- HTTPS RPC: QuickNode (https://www.quicknode.com)
- WebSocket: Helius (https://www.helius.dev)

## TODO

- [ ] Implement a sniping module to target tokens with predefined names
- [ ] Add support for sniping based on public presale contract addresses
- [ ] Develop functionality to snipe tokens based on specific wallet owners

## Disclaimer Copypasta

This bot is provided for educational and research purposes only. Trading cryptocurrencies carries a high level of risk, and may not be suitable for all investors. Before deciding to trade cryptocurrency you should carefully consider your investment objectives, level of experience, and risk appetite. The possibility exists that you could sustain a loss of some or all of your initial investment and therefore you should not invest money that you cannot afford to lose. You should be aware of all the risks associated with cryptocurrency trading, and seek advice from an independent financial advisor if you have any doubts.

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check [issues page](https://github.com/AmirAgassi/dump.fun/issues) if you want to contribute.
