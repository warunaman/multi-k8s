const keys = require('./keys');

//Express app setup
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());




console.log('Postgres client setup start');

//Postgres Client Setup
const { Pool } = require('pg');

// robust parsing of ssl flag (accepts boolean or string)
const pgSslFlag = (function () {
    if (typeof keys.pgSsl === 'boolean') return keys.pgSsl;
    if (typeof process.env.PG_SSL !== 'undefined') return process.env.PG_SSL === 'true';
    if (typeof keys.pgSsl === 'string') return keys.pgSsl.toLowerCase() === 'true';
    // default: enable SSL only in production if not explicitly provided
    return process.env.NODE_ENV === 'production';
})();

const pgClient = new Pool({
    user: keys.pgUser,
    host: keys.pgHost,
    database: keys.pgDatabase,
    password: keys.pgPassword,
    port: keys.pgPort,
    ssl: pgSslFlag ? { rejectUnauthorized: false } : false
});

// 💡 NEW: Listen for the 'error' event on the pool to catch connection issues
pgClient.on("error", (err) => {
    // This logs the error if the pool loses an idle client due to a network error
    // OR if an initial connection attempt fails.
    console.error("FATAL: Lost connection to PostgreSQL or initial connection failed.", err);
    // Depending on the severity, you might want to exit the application here.
    // process.exit(1); 
});

// Original 'connect' handler remains the same (for success logging and table creation)
pgClient.on("connect", (client) => {
    console.log("PostgreSQL client successfully connected and initialized.");
    client
        .query("CREATE TABLE IF NOT EXISTS values (number INT)")
        .catch((err) => console.error("Error creating table:", err)); 
});

console.log('Postgres client setup end');

(async function verifyPostgresConnection() {
    console.log('Verifying PostgreSQL connectivity...');
    try {
        console.log('Postgres config:', {
            host: keys.pgHost,
            port: keys.pgPort,
            user: keys.pgUser,
            database: keys.pgDatabase,
            ssl: !!pgClient.options.ssl
        });
        const result = await pgClient.query('SELECT NOW() AS now');
        console.log('PostgreSQL verification SUCCESS - server time:', result.rows[0].now);
    } catch (err) {
        console.error('PostgreSQL verification FAILED:', err.message || err);
        console.error(err.stack || err);

        // If failure indicates server does not support SSL, try a non-SSL test and log guidance
        if (/(does not support SSL|unsupported ssl)/i.test(err.message || '')) {
            console.warn('Detected "server does not support SSL connections" error. Trying a non-SSL test connection for diagnosis...');
            try {
                const testPool = new Pool({
                    user: keys.pgUser,
                    host: keys.pgHost,
                    database: keys.pgDatabase,
                    password: keys.pgPassword,
                    port: keys.pgPort,
                    ssl: false
                });
                const res2 = await testPool.query('SELECT NOW() AS now');
                console.log('NON-SSL verification SUCCESS - server time:', res2.rows[0].now);
                await testPool.end();
                console.warn('Actionable: Your Postgres server does not support SSL. Set keys.pgSsl or env PG_SSL to "false" (or disable ssl in your Pool config).');
            } catch (err2) {
                console.error('NON-SSL verification also FAILED:', err2.message || err2);
                console.error(err2.stack || err2);
            }
        }

        // optional: exit if DB is critical and unreachable
        // process.exit(1);
    }
})();


//Redis Client Setup
const redis = require('redis');
console.log('Redis host:', keys.redisHost);
console.log('Redis port:', keys.redisPort);
const redisClient = redis.createClient({
    host: keys.redisHost,
    port: keys.redisPort,
    retry_strategy: () => 1000
});
console.log('Redis client setup end');
redisClient.on('connect', () => {
    console.log('*** REDIS: Successfully connected to the Redis host! ***');
});
redisClient.on('error', (err) => {
    // If you see this, the connection failed. The error object (err) will give details.
    console.error('*** REDIS ERROR: Connection failed ***', err); 
});
const redisPublisher = redisClient.duplicate();

//Express route handlers

app.get('/', (req, res) => {
    res.send('Hi');
});

app.get('/values/all', async (req, res) => {
    const values = await pgClient.query('SELECT * from values');
    
    res.send(values.rows);
});

//app.get('/values/current', async (req, res) => {
//    console.log('Fetching values from Redis:');
//    redisClient.hgetall('values', (err, values) => {
//        res.send(values);
//    });
//    console.log('Fetching values from Redis: DONE');
//});
app.get('/values/current', (req, res) => {
    console.log('Fetching values from Redis: START'); // Log 1: Start time

    // **CRITICAL IMPROVEMENT:** Explicit error handling in the callback
    redisClient.hgetall('values', (err, values) => {
        if (err) {
            console.error('--- REDIS HGETALL ERROR ---'); // Log 2: Error flag
            console.error(err); // Log 3: Full error details (e.g., Command Timeout, Auth failure)
            return res.status(500).send({ error: 'Redis command failed', details: err.message });
        }
        
        console.log('Fetching values from Redis: SUCCESS'); // Log 4: Success confirmation
        res.send(values);
    });
    // Removed the misleading 'DONE' log which executed before the callback
});

app.post('/values', async (req, res) => {
    const index = req.body.index;

    if (parseInt(index) > 40) {
        return res.status(422).send('Index too high');
    }
    
    // Redis Write (HSET) with Logging
    redisClient.hset('values', index, 'Nothing yet!', (err, reply) => {
        if (err) {
            console.error(`REDIS HSET FAILURE for index ${index}:`, err);
        } else {
            console.log(`REDIS HSET SUCCESS for index ${index}. Reply: ${reply}`);
        }
    });
    
    // Redis Publish with Logging
    redisPublisher.publish('insert', index, (err) => {
        if (err) {
            console.error(`REDIS PUBLISH FAILURE for index ${index}:`, err);
        } else {
            console.log(`REDIS PUBLISH SUCCESS for index ${index}.`);
        }
    });

    // CRITICAL IMPROVEMENT: Await the DB query to catch immediate errors
    try {
        await pgClient.query('INSERT INTO values(number) VALUES($1)', [index]);
        console.log(`PG INSERT SUCCESS for index ${index}.`);
    } catch (err) {
        console.error(`PG INSERT FAILURE for index ${index}:`, err);
        return res.status(500).send({ error: 'PostgreSQL insertion failed' });
    }
    
    res.send({ working: true, index: index });
});

app.listen(5000, err => {
    console.log('Listening on port 5000');
});
