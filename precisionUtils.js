/**
 * Precision Utility Module
 * Centralized precision management for trading symbols
 * Provides consistent formatting across trading logic and UI displays
 */

class PrecisionFormatter {
  constructor() {
    this.precisionCache = {};
  }

  /**
   * Calculate precision (number of decimal places) from step/tick size
   */
  getPrecision(value) {
    if (value === null || value === undefined || value === 0) return 0;
    const parts = value.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  /**
   * Cache precision data for a symbol
   */
  cachePrecision(symbol, tickSize, stepSize, minNotional = null) {
    this.precisionCache[symbol] = {
      tickSize: parseFloat(tickSize),
      stepSize: parseFloat(stepSize),
      pricePrecision: this.getPrecision(parseFloat(tickSize)),
      quantityPrecision: this.getPrecision(parseFloat(stepSize)),
      minNotional: minNotional ? parseFloat(minNotional) : null,
    };
    return this.precisionCache[symbol];
  }

  /**
   * Get cached precision data for a symbol
   */
  getPrecisionData(symbol) {
    return this.precisionCache[symbol] || null;
  }

  /**
   * Format price using symbol-specific precision
   */
  formatPrice(price, symbol = null) {
    if (price === null || price === undefined || isNaN(price)) return 'N/A';

    const numPrice = typeof price === 'string' ? parseFloat(price) : price;
    if (isNaN(numPrice)) return 'N/A';

    if (symbol && this.precisionCache[symbol]) {
      return numPrice.toFixed(this.precisionCache[symbol].pricePrecision);
    }

    // Default to 2 decimal places for prices
    return numPrice.toFixed(2);
  }

  /**
   * Format quantity using symbol-specific precision
   */
  formatQuantity(quantity, symbol = null) {
    if (quantity === null || quantity === undefined || isNaN(quantity)) return 'N/A';

    const numQty = typeof quantity === 'string' ? parseFloat(quantity) : quantity;
    if (isNaN(numQty)) return 'N/A';

    if (symbol && this.precisionCache[symbol]) {
      return numQty.toFixed(this.precisionCache[symbol].quantityPrecision);
    }

    // Default to 6 decimal places for quantities
    return numQty.toFixed(6);
  }

  /**
   * Format notional value (USDT amounts)
   * Always uses 2 decimal places
   */
  formatNotional(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return 'N/A';

    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return 'N/A';

    return numAmount.toFixed(2);
  }

  /**
   * Format percentage values
   * Always uses 2 decimal places
   */
  formatPercentage(percentage) {
    if (percentage === null || percentage === undefined || isNaN(percentage)) return 'N/A';

    const numPct = typeof percentage === 'string' ? parseFloat(percentage) : percentage;
    if (isNaN(numPct)) return 'N/A';

    return numPct.toFixed(2);
  }

  /**
   * Round price to symbol-specific precision (returns number)
   */
  roundPrice(price, symbol) {
    if (!symbol || !this.precisionCache[symbol]) return price;
    const precision = this.precisionCache[symbol].pricePrecision;
    return parseFloat(price.toFixed(precision));
  }

  /**
   * Round quantity to symbol-specific precision (returns number)
   */
  roundQuantity(quantity, symbol) {
    if (!symbol || !this.precisionCache[symbol]) return quantity;
    const precision = this.precisionCache[symbol].quantityPrecision;
    return parseFloat(quantity.toFixed(precision));
  }

  /**
   * Get price precision for a symbol
   */
  getPricePrecision(symbol) {
    return this.precisionCache[symbol]?.pricePrecision ?? 2;
  }

  /**
   * Get quantity precision for a symbol
   */
  getQuantityPrecision(symbol) {
    return this.precisionCache[symbol]?.quantityPrecision ?? 6;
  }

  /**
   * Clear precision cache
   */
  clearCache() {
    this.precisionCache = {};
  }

  /**
   * Clear precision cache for specific symbol
   */
  clearSymbol(symbol) {
    delete this.precisionCache[symbol];
  }
}

// Export singleton instance
export const precisionFormatter = new PrecisionFormatter();

// Export class for testing or creating new instances
export default PrecisionFormatter;
