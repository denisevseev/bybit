function sendTradeNotification(bot, chatId, message) {
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
        console.error('Error sending message to Telegram:', error.message);
    });
}

function sendStatusUpdate(bot, chatId, symbol, currentPrice, profitPercent, totalProfit, totalLoss) {
    const message = `
        ✅ Trade Update:
        Symbol: ${symbol}
        Current Price: ${currentPrice}
        Profit: ${profitPercent}%
        Total Profit: ${totalProfit} USDT
        Total Loss: ${totalLoss} USDT
    `;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
        console.error('Error sending status update to Telegram:', error.message);
    });
}

module.exports = { sendTradeNotification, sendStatusUpdate };

