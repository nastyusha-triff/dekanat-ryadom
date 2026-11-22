// Small arithmetic grammar. No eval, property access, statements or executable code.
export function parseFormula(source, resolve) {
  if (typeof source !== 'string' || !source.trim() || source.length > 2000) throw new Error('Формула должна содержать от 1 до 2000 символов.');
  let pos = 0, count = 0;
  const bindings = {}, ids = new Set();
  const fail = message => { throw new Error(`${message} Позиция ${pos + 1}.`); };
  const space = () => { while (/\s/.test(source[pos] || '') && pos < source.length) pos++; };
  const take = char => { space(); if (source[pos] === char) { pos++; return true; } return false; };
  function primary(depth) {
    if (depth > 32 || ++count > 256) fail('Формула слишком сложная.');
    space();
    if (take('+')) return primary(depth + 1);
    if (take('-')) return {op:'negate', args:[primary(depth + 1)]};
    if (take('(')) { const value = expression(depth + 1); if (!take(')')) fail('Ожидается ).'); return value; }
    if (take('[')) {
      const end = source.indexOf(']', pos); if (end < 0) fail('Закройте ссылку на оценку символом ].');
      const label = source.slice(pos, end).trim(); pos = end + 1;
      if (!label || label.includes('[')) fail('Некорректная ссылка на оценку.');
      const id = resolve(label); if (!id) fail(`Неизвестная оценка «${label}».`);
      bindings[label] = id; ids.add(id); return {ref:id};
    }
    const number = source.slice(pos).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) { pos += number[0].length; const value = Number(number[0]); if (!Number.isFinite(value)) fail('Слишком большое число.'); return {number:value}; }
    const fn = source.slice(pos).match(/^[A-Za-z_]+/);
    if (fn) {
      pos += fn[0].length; if (!['sum','min','max'].includes(fn[0])) fail('Разрешены только sum, min и max.');
      if (!take('(')) fail('После функции ожидается (.');
      const args = [expression(depth + 1)]; while (take(',')) args.push(expression(depth + 1));
      if (!take(')')) fail('Ожидается ).'); return {op:fn[0], args};
    }
    fail('Ожидается число, [наименование оценки] или функция.');
  }
  function product(depth) { let node = primary(depth); for (;;) { space(); const op = source[pos]; if (!['*','/'].includes(op)) return node; pos++; node = {op,args:[node,primary(depth + 1)]}; } }
  function expression(depth) { let node = product(depth); for (;;) { space(); const op = source[pos]; if (!['+','-'].includes(op)) return node; pos++; node = {op,args:[node,product(depth + 1)]}; } }
  const ast = expression(0); space(); if (pos !== source.length) fail('Недопустимый символ.');
  if (!ids.size) throw new Error('Добавьте в формулу хотя бы одну оценку в квадратных скобках.');
  return {ast, bindings, ids:[...ids]};
}

export function evaluateFormula(ast, values) {
  function visit(node) {
    if ('number' in node) return node.number;
    if (node.ref) { const value = values.get(node.ref); if (!Number.isFinite(value)) throw new Error('Не все оценки опубликованы.'); return value; }
    const args = node.args.map(visit); let value;
    switch (node.op) {
      case '+': value = args[0] + args[1]; break;
      case '-': value = args[0] - args[1]; break;
      case '*': value = args[0] * args[1]; break;
      case '/': if (args[1] === 0) throw new Error('Деление на ноль.'); value = args[0] / args[1]; break;
      case 'negate': value = -args[0]; break;
      case 'sum': value = args.reduce((a,b) => a+b,0); break;
      case 'min': value = Math.min(...args); break;
      case 'max': value = Math.max(...args); break;
      default: throw new Error('Неизвестный оператор.');
    }
    if (!Number.isFinite(value)) throw new Error('Результат не является конечным числом.');
    return value;
  }
  return visit(ast);
}
