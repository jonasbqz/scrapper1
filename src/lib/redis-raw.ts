import Redis from 'ioredis';

let redisClient: Redis | null = null;

export function getRedisRaw(): Redis | null {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.warn('[redis-raw] REDIS_URL no definida.');
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      // Se elimina enableOfflineQueue: false para que ioredis encole los comandos 
      // mientras termina de conectarse en los primeros milisegundos de arranque del server.
    });

    redisClient.on('error', (err) => {
      console.error('[redis-raw] Error de conexión:', err.message);
    });

    return redisClient;
  } catch (err) {
    console.error('[redis-raw] No se pudo inicializar:', err);
    return null;
  }
}
