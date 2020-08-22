/* eslint-disable no-restricted-properties */
const _ = require('lodash');
const config = require('config');
const cache = require('../../helpers/cache');

/**
 * Cancel any open orders to get available balance
 *
 * @param {*} logger
 * @param {*} symbol
 */
const cancelOpenOrders = async (logger, binance, symbol) => {
  logger.info('Cancelling open orders');
  // Cancel open orders first to make sure it does not have unsettled orders.
  try {
    const result = await binance.client.cancelOpenOrders({ symbol });
    logger.info({ result }, 'Cancelled open orders');
  } catch (e) {
    logger.info({ e }, 'Cancel result failed, but it is ok. Do not worry');
  }
};

/**
 * Get symbol information
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} symbol
 */
const getSymbolInfo = async (logger, binance, symbol) => {
  const cachedSymbolInfo = await cache.get(`symbol-info-${symbol}`);
  if (cachedSymbolInfo) {
    logger.info({ cachedSymbolInfo }, 'Retrieved symbol info from cache');
    return JSON.parse(cachedSymbolInfo);
  }

  logger.info({}, 'Request exchange info from Binance');
  const exchangeInfo = await binance.client.exchangeInfo();
  logger.info({}, 'Retrieved exchange info from Binance');
  const symbolInfo =
    _.filter(exchangeInfo.symbols, s => {
      return s.symbol === symbol;
    })[0] || {};

  symbolInfo.filterLotSize = _.filter(symbolInfo.filters, f => f.filterType === 'LOT_SIZE')[0] || {};
  symbolInfo.filterPrice = _.filter(symbolInfo.filters, f => f.filterType === 'PRICE_FILTER')[0] || {};
  symbolInfo.filterPercent = _.filter(symbolInfo.filters, f => f.filterType === 'PERCENT_PRICE')[0] || {};
  symbolInfo.filterMinNotional = _.filter(symbolInfo.filters, f => f.filterType === 'MIN_NOTIONAL')[0] || {};

  const success = await cache.set(`symbol-info-${symbol}`, JSON.stringify(symbolInfo));
  logger.info({ success, symbolInfo }, 'Retrieved symbol info from Binance');
  return symbolInfo;
};

/**
 * Retrieve balance for trade asset based on the side
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} side
 */
const getBalance = async (logger, binance, symbolInfo, side) => {
  // 1. Get account info
  const accountInfo = await binance.client.accountInfo();
  logger.info('Retrieved Account info');

  const tradeAsset = side === 'buy' ? symbolInfo.quoteAsset : symbolInfo.baseAsset;
  logger.info({ tradeAsset }, 'Determined trade asset');

  // 2. Get trade asset balance
  const balance =
    _.filter(accountInfo.balances, b => {
      return b.asset === tradeAsset;
    })[0] || {};

  if (_.isEmpty(balance)) {
    logger.error({ symbolInfo, balance }, 'Balance cannot be found.');
    return {
      result: false,
      message: 'Balance cannot be found.',
      balance
    };
  }

  logger.info({ balance }, 'Balance found');

  // 3. Calculate free balance with precision
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const freeBalance = +(+balance.free).toFixed(lotPrecision);

  // 4. Validate free balance for buy action
  if (side === 'buy' && freeBalance < +symbolInfo.filterMinNotional.minNotional) {
    logger.error({ freeBalance }, 'Balance is less than minimum notional.');

    return {
      result: false,
      message: 'Balance is less than minimum notional.',
      freeBalance
    };
  }

  return {
    result: true,
    message: 'Balance found',
    freeBalance
  };
};

/**
 * Calculate order quantity
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} side
 * @param {*} balanceInfo
 * @param {*} percentage
 * @param {*} indicators
 */
const getOrderQuantity = (logger, symbolInfo, side, balanceInfo, percentage, indicators) => {
  const baseAssetPrice = +indicators.lastCandle.close;
  logger.info({ baseAssetPrice }, 'Retrieved latest asset price');

  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const { freeBalance } = balanceInfo;

  let orderQuantity = 0;

  if (side === 'buy') {
    const orderQuantityBeforeCommission = 1 / (+baseAssetPrice / freeBalance / (percentage / 100));
    orderQuantity = +(orderQuantityBeforeCommission - orderQuantityBeforeCommission * (0.1 / 100)).toFixed(
      lotPrecision
    );

    if (orderQuantity <= 0) {
      logger.error({ freeBalance, orderQuantity }, 'Order quantity is less or equal than 0.');
      return {
        result: false,
        message: 'Order quantity is less or equal than 0.',
        baseAssetPrice,
        orderQuantity,
        freeBalance
      };
    }
  }

  if (side === 'sell') {
    const orderQuantityBeforeCommission = freeBalance * (percentage / 100);
    orderQuantity = +(orderQuantityBeforeCommission - orderQuantityBeforeCommission * (0.1 / 100)).toFixed(
      lotPrecision
    );

    if (orderQuantity <= +symbolInfo.filterLotSize.minQty) {
      logger.error(
        { freeBalance, symbolInfo },
        `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`
      );
      return {
        result: false,
        message: `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`,
        baseAssetPrice,
        orderQuantity,
        freeBalance
      };
    }
  }
  logger.info({ orderQuantity }, 'Order quantity');

  return {
    result: true,
    message: `Calculated order quantity`,
    baseAssetPrice,
    orderQuantity,
    freeBalance
  };
};

/**
 * Calculate order price
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} orderQuantityInfo
 */
const getOrderPrice = (logger, symbolInfo, orderQuantityInfo) => {
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;
  const orderPrice = +(+orderQuantityInfo.baseAssetPrice).toFixed(orderPrecision);
  logger.info({ orderPrecision, orderPrice }, 'Calculated order price');

  if (orderQuantityInfo.orderQuantity * orderPrice < symbolInfo.filterMinNotional.minNotional) {
    return {
      result: false,
      message: `Order quantity * Order price is less than minNotional.`,
      orderQuantity: orderQuantityInfo.orderQuantity,
      orderPrice,
      orderCost: orderQuantityInfo.orderQuantity * orderPrice,
      minNotional: symbolInfo.filterMinNotional.minNotional
    };
  }

  return {
    result: true,
    message: `Calculated order price`,
    orderPrice
  };
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} symbol
 */
const getOpenOrders = async (logger, binance, symbol) => {
  const openOrders = await binance.client.openOrders({ symbol });
  logger.info({ openOrders }, 'Get open orders');

  return openOrders;
};

/**
 * Calculate round down
 *
 * @param {*} number
 * @param {*} decimals
 */
const roundDown = (number, decimals = 0) => {
  return Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

/**
 * Place stop loss limit order
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} slack
 * @param {*} symbolInfo
 * @param {*} balanceInfo
 * @param {*} indicators
 * @param {*} stopLossLimitInfo
 */
const placeStopLossLimitOrder = async (
  logger,
  binance,
  slack,
  symbolInfo,
  balanceInfo,
  indicators,
  stopLossLimitInfo
) => {
  logger.info({}, 'Started place stop loss limit order');
  const { symbol } = symbolInfo;
  const lastBuyPrice = +(await cache.get(`last-buy-price-${symbol}`)) || 0;
  logger.info({ lastBuyPrice }, 'Retrieved last buy price');

  const lastCandleClose = +indicators.lastCandle.close;
  logger.info({ lastCandleClose }, 'Retrieved last closed price');

  const calculatedLastBuyPrice = lastBuyPrice * +config.get('jobs.macdStopChaser.stopLossLimit.lastBuyPercentage');
  if (lastCandleClose < calculatedLastBuyPrice) {
    logger.error(
      {
        lastCandleClose,
        lastBuyPrice,
        calculatedLastBuyPrice
      },
      `Last buy price is lower than current price. Do not place order.`
    );
    return {
      result: false,
      message: `Last buy price is lower than current price. Do not place order.`,
      lastCandleClose,
      lastBuyPrice
    };
  }

  logger.info(
    { lastCandleClose, lastBuyPrice, calculatedLastBuyPrice },
    `Last buy price is higher than current price. Place order.`
  );

  const basePrice = +indicators.lastCandle.close;
  const balance = balanceInfo.freeBalance;
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;

  logger.info(
    { lastBuyPrice, lastCandleClose, basePrice, balance, orderPrecision, stopLossLimitInfo },
    'Prepare params'
  );

  const stopPrice = roundDown(basePrice * +stopLossLimitInfo.stopPercentage, orderPrecision);
  const price = roundDown(basePrice * +stopLossLimitInfo.limitPercentage, orderPrecision);

  // Calculate quantity - commission
  const quantity = +(balance - balance * (0.1 / 100)).toFixed(lotPrecision);

  if (quantity <= +symbolInfo.filterLotSize.minQty) {
    logger.error(
      { quantity },
      `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`
    );
    return {
      result: false,
      message: `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`,
      quantity
    };
  }

  if (quantity * price < symbolInfo.filterMinNotional.minNotional) {
    logger.error(
      { quantity, price, minNotional: symbolInfo.filterMinNotional.minNotional },
      `Order quantity * Order price is less than minNotional.`
    );
    return {
      result: false,
      message: `Order quantity * Order price is less than minNotional.`,
      quantity,
      price,
      orderCost: quantity * price,
      minNotional: symbolInfo.filterMinNotional.minNotional
    };
  }

  const orderParams = {
    symbol: symbolInfo.symbol,
    side: 'sell',
    type: 'STOP_LOSS_LIMIT',
    quantity,
    price,
    timeInForce: 'GTC',
    stopPrice
  };

  logger.info({ orderParams }, 'Order params');

  slack.sendMessage(`Action: *STOP_LOSS_LIMIT*
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);
  const orderResult = binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await slack.sendMessage(
    `Action Result: *STOP_LOSS_LIMIT*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );

  return orderResult;
};

module.exports = {
  cancelOpenOrders,
  getSymbolInfo,
  getBalance,
  getOrderQuantity,
  getOrderPrice,
  getOpenOrders,
  placeStopLossLimitOrder
};
