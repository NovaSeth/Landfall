// Monthly sales report. Finance parses this text, so its exact format is part of the contract.

export function buildReport(orders, options = {}) {
  const currency = options.currency || 'USD';
  let lines = [];
  let customers = {};
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (!customers[o.customer]) customers[o.customer] = { gross: 0, refunds: 0, count: 0 };
    if (o.refunded) {
      customers[o.customer].refunds = customers[o.customer].refunds + o.amountCents;
    } else {
      customers[o.customer].gross = customers[o.customer].gross + o.amountCents;
      customers[o.customer].count = customers[o.customer].count + 1;
    }
  }
  const names = Object.keys(customers).sort();
  let total = 0;
  let totalRefunds = 0;
  for (let i = 0; i < names.length; i++) {
    const c = customers[names[i]];
    let discount = 0;
    if (c.gross >= 100000) discount = Math.round(c.gross * 0.1);
    else if (c.gross >= 50000) discount = Math.round(c.gross * 0.05);
    const net = c.gross - discount - c.refunds;
    total = total + net;
    totalRefunds = totalRefunds + c.refunds;
    let amount = (net / 100).toFixed(2);
    if (currency === 'EUR') amount = amount.replace('.', ',') + ' EUR';
    else amount = '$' + amount;
    let line = names[i] + ': ' + amount + ' (' + c.count + ' orders';
    if (discount > 0) {
      let d = (discount / 100).toFixed(2);
      if (currency === 'EUR') d = d.replace('.', ',') + ' EUR';
      else d = '$' + d;
      line = line + ', discount ' + d;
    }
    lines.push(line + ')');
  }
  let totalStr = (total / 100).toFixed(2);
  if (currency === 'EUR') totalStr = totalStr.replace('.', ',') + ' EUR';
  else totalStr = '$' + totalStr;
  let refundStr = (totalRefunds / 100).toFixed(2);
  if (currency === 'EUR') refundStr = refundStr.replace('.', ',') + ' EUR';
  else refundStr = '$' + refundStr;
  lines.push('TOTAL: ' + totalStr);
  if (totalRefunds > 0) lines.push('REFUNDS: ' + refundStr);
  if (orders.length === 0) return 'No orders.';
  return lines.join('\n');
}
