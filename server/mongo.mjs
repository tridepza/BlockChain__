import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCACertificates } from 'node:tls';
import { parseEnv } from 'node:util';
import { MongoClient } from 'mongodb';

class MongoSetupError extends Error {}

export function mongoConfig(root = process.cwd()) {
  const mode = process.env.ESCROW_DB;
  if (mode && mode !== 'mongodb') return null;
  const path = resolve(root, '.env.mongo.local');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const env = { ...file, ...process.env };
  const uri = env.MONGODB_URI;
  if (!uri && !mode) return null;
  if (!uri) throw new MongoSetupError('Điền MONGODB_URI trong .env.mongo.local.');
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new MongoSetupError('MONGODB_URI cần bắt đầu bằng mongodb+srv:// hoặc mongodb://.');
  }
  if (/<(?:db_password|password)>/i.test(uri)) {
    throw new MongoSetupError('Thay <db_password> trong MONGODB_URI bằng mật khẩu tài khoản database Atlas.');
  }
  return { uri, database: env.MONGODB_DB || 'freelancer_escrow', useSystemCA: env.MONGODB_USE_SYSTEM_CA === '1' };
}

export function mongoError(error) {
  if (error instanceof MongoSetupError) return error.message;
  if (error.code === 18 || error.code === 8000) return 'MongoDB từ chối đăng nhập. Kiểm tra tài khoản database và mật khẩu trong URI.';
  if (error.code === 13) return 'Tài khoản MongoDB thiếu quyền trên database dự án.';
  if (error.name === 'MongoParseError') return 'Chuỗi MONGODB_URI không hợp lệ. Kiểm tra lại URI trong Atlas.';
  if (error.syscall === 'querySrv' || error.syscall === 'queryTxt') {
    return 'Node.js không tra được DNS của MongoDB Atlas. Thử chuỗi mongodb:// trong mục Legacy URI String.';
  }
  if (error.name === 'MongoServerSelectionError' && error.reason?.type === 'ReplicaSetNoPrimary' &&
      [...error.reason.servers.values()].some(server => server.type === 'RSSecondary')) {
    return 'Đã kết nối được node phụ của MongoDB, nhưng chưa chọn được node chính để ghi dữ liệu. Kiểm tra cluster và kết nối mạng.';
  }
  if (error.name === 'MongoServerSelectionError' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return 'Không kết nối được MongoDB. Kiểm tra cluster, kết nối mạng và IP Access List trong Atlas.';
  }
  return 'Thao tác MongoDB thất bại.';
}

export function openMongo(config) {
  const client = new MongoClient(config.uri, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 20000,
    promoteBuffers: true,
    ignoreUndefined: true,
    ...(config.useSystemCA ? { ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])] } : {}),
  });
  const db = client.db(config.database);
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const projects = db.collection('projects');
  const transactions = db.collection('transactions');
  const counters = db.collection('counters');
  const walletLinks = db.collection('wallet_links');
  const walletChallenges = db.collection('wallet_challenges');
  const deliveryFiles = db.collection('delivery_files');
  const collections = [users, sessions, projects, transactions, counters, walletLinks, walletChallenges, deliveryFiles];
  const projectCounter = { _id: 'projects' };
  const withoutStorageId = { projection: { _id: 0 } };

  function operations(session) {
    const options = { session };
    return {
      getUserByEmail: email => users.findOne({ email }, { ...options, ...withoutStorageId }),
      async createUser(user) {
        try {
          await users.insertOne({ ...user, _id: user.id }, options);
          return true;
        } catch (error) {
          if (error.code === 11000 && error.keyPattern?.email) return false;
          throw error;
        }
      },
      async getSessionUser(tokenHash, lock = false) {
        const filter = { _id: tokenHash, expiresAt: { $gt: new Date() } };
        // Write to the session in the same transaction so logout and writes cannot pass each other.
        const active = lock
          ? await sessions.findOneAndUpdate(filter, { $inc: { writeVersion: 1 } }, options)
          : await sessions.findOne(filter, options);
        if (!active) return null;
        return users.findOne({ _id: active.userId }, { ...options, projection: { _id: 0, id: 1, name: 1, email: 1, role: 1 } });
      },
      deleteSession: tokenHash => sessions.deleteOne({ _id: tokenHash }, options),
      insertSession: (tokenHash, userId, expires) =>
        sessions.insertOne({ _id: tokenHash, userId, expiresAt: new Date(expires) }, options),
      updateUserName: (id, name) => users.updateOne({ _id: id }, { $set: { name } }, options),
      getWalletLink: userId => walletLinks.findOne({ _id: userId }, { ...options, ...withoutStorageId }),
      async insertWalletLink(userId, wallet) {
        try {
          await walletLinks.insertOne({ _id: userId, ...wallet }, options);
          return true;
        } catch (error) {
          if (error.code === 11000) return false;
          throw error;
        }
      },
      createWalletChallenge: challenge => walletChallenges.insertOne({
        ...challenge, _id: challenge.id, expiresAt: new Date(challenge.expires),
      }, options),
      getWalletChallenge: (id, userId, sessionId) => walletChallenges.findOne({ _id: id, userId, sessionId }, options),
      async consumeWalletChallenge(id, userId, sessionId, now) {
        const result = await walletChallenges.deleteOne({ _id: id, userId, sessionId, expiresAt: { $gt: new Date(now) } }, options);
        return result.deletedCount === 1;
      },
      listOpenProjects: () => projects.find({ status: 'Open' }, { ...options, ...withoutStorageId }).sort({ _id: -1 }).toArray(),
      async readWorkspace() {
        // Both reads use the same snapshot, including when an escrow update writes to both collections.
        const projectRows = await projects.find({}, { ...options, ...withoutStorageId }).sort({ _id: -1 }).toArray();
        const txs = await transactions.find({}, { ...options, ...withoutStorageId }).sort({ _id: -1 }).toArray();
        return { projects: projectRows, txs };
      },
      async createProject(project) {
        const counter = await counters.findOneAndUpdate(projectCounter, { $inc: { value: 1 } },
          { ...options, returnDocument: 'after' });
        const saved = { ...project, id: counter.value };
        await projects.insertOne({ ...saved, _id: saved.id }, options);
        return saved;
      },
      getProject: id => projects.findOne({ _id: id }, { ...options, ...withoutStorageId }),
      saveProject: project => projects.replaceOne({ _id: project.id }, { ...project, _id: project.id }, options),
      saveDeliveryFile: (id, kind, file) => deliveryFiles.insertOne({ _id: `${id}:${kind}`, ...file }, options),
      getDeliveryFile: (id, kind) => deliveryFiles.findOne({ _id: `${id}:${kind}` }, { ...options, ...withoutStorageId }),
      addTransaction: tx => transactions.insertOne({ ...tx }, options),
    };
  }

  function transaction(operation) {
    return client.withSession(session => session.withTransaction(() => operation(operations(session)), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      timeoutMS: 10000,
    }));
  }

  async function checkDeployment() {
    const hello = await db.command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new MongoSetupError('MongoDB cần Atlas hoặc replica set để cập nhật dự án và giao dịch cùng lúc.');
    }
  }

  return {
    ...operations(),
    readWorkspace: () => transaction(store => store.readWorkspace()),
    transaction,
    close: () => client.close(),
    async migrate() {
      await checkDeployment();
      for (const collection of collections) {
        try {
          await db.createCollection(collection.collectionName);
        } catch (error) {
          if (error.code !== 48) throw error;
        }
      }
      await users.createIndex({ email: 1 }, { unique: true });
      await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await walletLinks.createIndex({ address: 1 }, { unique: true });
      await walletChallenges.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      const latest = await projects.findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } });
      const highestProjectId = latest?._id ?? 0;
      if (!Number.isSafeInteger(highestProjectId) || highestProjectId < 0) {
        throw new MongoSetupError('Collection projects có dữ liệu khác cấu trúc. Chọn MONGODB_DB riêng cho dự án.');
      }
      await counters.updateOne(projectCounter, { $max: { value: highestProjectId } }, { upsert: true });
    },
    async check() {
      await checkDeployment();
      const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name));
      let ready = collections.every(collection => names.has(collection.collectionName));
      if (ready) {
        const emailIndexes = await users.indexes();
        const sessionIndexes = await sessions.indexes();
        const walletIndexes = await walletLinks.indexes();
        const challengeIndexes = await walletChallenges.indexes();
        ready = emailIndexes.some(index => index.name === 'email_1' && index.unique === true)
          && sessionIndexes.some(index => index.name === 'expiresAt_1' && index.expireAfterSeconds === 0)
          && walletIndexes.some(index => index.name === 'address_1' && index.unique === true)
          && challengeIndexes.some(index => index.name === 'expiresAt_1' && index.expireAfterSeconds === 0)
          && Boolean(await counters.findOne(projectCounter));
      }
      return { database: db.databaseName, ready };
    },
  };
}
