import {localAddress,portAvailable,reportOccupied} from '../server/local-port.mjs';

try {
  const address=localAddress();
  // Exit 10 means a healthy existing portal can be reused without seeding again.
  if(!await portAvailable(address))process.exitCode=await reportOccupied(address)?10:1;
} catch(error) {
  console.error('Не удалось проверить адрес запуска:',error.code||error.message);
  process.exitCode=1;
}
