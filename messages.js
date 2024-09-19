// messages.js

const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с вашим токеном
const bot = new TelegramBot('6898599983:AAGCokpNt5YxG6_DmcnCOju4UHKJYOE7UlE');
const chatId = '5761109418';

module.exports = {
    sendStartMessage: () => {
        bot.sendMessage(chatId, '---------НОВОЕ НАЧАЛО--------').catch((error) => {
            console.error('Ошибка при отправке сообщения в Telegram:', error.message);
        });
    },

    sendTradeEntryMessage: (symbol, direction, entryPrice) => {
        const directionText = direction === 'up' ? '📈 Покупка' : '📉 Продажа';
        const formattedSymbol = symbol.replace('USDT', '_USDT');
        const message = `
<b>Вход в сделку (${directionText}):</b> ${formattedSymbol}
Цена входа: <b>${entryPrice}</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?type=spot">Открыть в Binance</a>
`;
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
            console.error('Ошибка при отправке сообщения в Telegram:', error.message);
        });
    },

    sendProfitMessage: (symbol, profit, profitPercent, currentPrice, totalProfit, totalLoss) => {
        const formattedSymbol = symbol.replace('USDT', '/USDT');
        const message = `
✅ <b>Сделка закрыта с прибылью!</b>
Пара: ${formattedSymbol}
Прибыль: <b>${profit.toFixed(2)} USDT (${profitPercent.toFixed(2)}%)</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
            console.error('Ошибка при отправке сообщения в Telegram:', error.message);
        });
    },

    sendLossMessage: (symbol, loss, currentPrice, totalProfit, totalLoss) => {
        const formattedSymbol = symbol.replace('USDT', '/USDT');
        const message = `
❌ <b>Сделка закрыта с убытком.</b>
Пара: ${formattedSymbol}
Убыток: <b>${loss.toFixed(2)} USDT</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
            console.error('Ошибка при отправке сообщения в Telegram:', error.message);
        });
    },

    sendUpdateMessageList: (message) => {
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
            console.error('Ошибка при отправке сообщения в Telegram:', error.message);
        });
    }
};
