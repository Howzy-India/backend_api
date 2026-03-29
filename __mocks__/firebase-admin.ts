// Mock firebase-admin so tests don't need a real Firebase project

class Timestamp {
  private _date: Date;
  constructor(seconds: number, nanoseconds: number) {
    this._date = new Date(seconds * 1000);
  }
  toDate() { return this._date; }
  static now() { return new Timestamp(Date.now() / 1000, 0); }
  static fromDate(d: Date) { return new Timestamp(d.getTime() / 1000, 0); }
}

const FieldValue = {
  serverTimestamp: () => null,
  increment: (n: number) => n,
  arrayUnion: (...args: any[]) => args,
  arrayRemove: (...args: any[]) => args,
};

const mockCollection = () => ({
  doc: jest.fn(),
  add: jest.fn(),
  get: jest.fn(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
});

const firestoreFn = jest.fn(() => ({
  collection: mockCollection,
  batch: jest.fn(() => ({
    set: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn(),
  })),
  doc: jest.fn(),
})) as any;

firestoreFn.FieldValue = FieldValue;
firestoreFn.Timestamp = Timestamp;

const authFn = jest.fn(() => ({
  getUser: jest.fn(),
  setCustomUserClaims: jest.fn(),
  createUser: jest.fn(),
  deleteUser: jest.fn(),
  updateUser: jest.fn(),
}));

const storageFn = jest.fn(() => ({
  bucket: jest.fn(() => ({ file: jest.fn() })),
}));

const apps: any[] = [];

const initializeApp = jest.fn(() => {
  const app = { name: "[DEFAULT]" };
  apps.push(app);
  return app;
});

module.exports = {
  apps,
  initializeApp,
  firestore: firestoreFn,
  auth: authFn,
  storage: storageFn,
};
