const axios = require('axios');
const fs = require('fs');

// Константы для подключения к Binance API
const BASE_URL = 'https://fapi.binance.com';  // Для фьючерсов
const HISTORICAL_ENDPOINT = '/fapi/v1/klines';
const SYMBOLS_ENDPOINT = '/fapi/v1/exchangeInfo';

async function getAllSymbols() {
    try {
        const response = await axios.get(`${BASE_URL}${SYMBOLS_ENDPOINT}`);
        const symbols = response.data.symbols.map(s => s.symbol);
        return symbols;
    } catch (error) {
        console.error('Ошибка получения символов:', error.message);
        return [];
    }
}

async function getHistoricalData(symbol) {
    const params = {
        symbol,
        interval: '1h',  // Часовые свечи
        limit: 100  // Количество свечей для анализа
    };

    try {
        const response = await axios.get(`${BASE_URL}${HISTORICAL_ENDPOINT}`, { params });
        return response.data.map(kline => ({
            open: parseFloat(kline[1]),
            high: parseFloat(kline[2]),
            low: parseFloat(kline[3]),
            close: parseFloat(kline[4])
        }));
    } catch (error) {
        console.error(`Ошибка получения исторических данных для ${symbol}:`, error.message);
        return [];
    }
}

async function analyzeSymbol(symbol) {
    try {
        const klines = await getHistoricalData(symbol);
        let growths = 0;
        let corrections = 0;

        for (let i = 1; i < klines.length; i++) {
            const previousClose = klines[i - 1].close;
            const currentClose = klines[i].close;

            // Проверка на рост цены на 10%
            if ((currentClose - previousClose) / previousClose >= 0.05) {
                growths++;
                const nextClose = klines[i + 1]?.close;
                // Проверка на коррекцию на 5% после роста
                if (nextClose && (previousClose - nextClose) / previousClose >= 0.01) {
                    corrections++;
                }
            }
        }

        console.log(`Анализ символа ${symbol}: Ростов на 10%: ${growths}, Коррекций: ${corrections}`);
        return { symbol, growths, corrections };
    } catch (error) {
        console.error(`Ошибка анализа символа ${symbol}:`, error.message);
        return null;
    }
}

async function analyzeAllSymbols() {
    const symbols = await getAllSymbols();
    let results = [];

    for (let symbol of symbols) {
        const analysis = await analyzeSymbol(symbol);
        if (analysis) {
            results.push(analysis);
        }
    }

    // Записываем результаты в файл
    fs.writeFileSync('analysis_results.json', JSON.stringify(results, null, 2));
    console.log('Анализ завершен, результаты записаны в analysis_results.json');
}

analyzeAllSymbols();
