/**
 * Minimal in-memory stand-in for the injected Drizzle client, for unit tests.
 *
 * Deliberately ignores `where` clauses: reproducing Drizzle's SQL AST would be
 * a second ORM, and every test here works on a single interview/problem, so
 * "all rows of the requested table" is the same answer. What it *does* model
 * faithfully is the builder shape (`select().from().where().orderBy().limit()`,
 * `insert().values().returning()`, `update().set().where()`) and the fact that
 * every builder is awaitable at any point in the chain.
 */
export type FakeRow = Record<string, unknown>;

type TableRef = object;

class Thenable<T> implements PromiseLike<T> {
  constructor(private readonly resolve: () => T) {}

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.resolve()).then(onFulfilled, onRejected);
  }
}

class SelectBuilder extends Thenable<FakeRow[]> {
  constructor(
    private readonly db: FakeDb,
    private rows: FakeRow[] = []
  ) {
    super(() => this.rows);
  }

  from(table: TableRef) {
    this.rows = this.db.rowsFor(table);
    return this;
  }

  where(_condition: unknown) {
    return this;
  }

  orderBy(..._args: unknown[]) {
    return this;
  }

  limit(n: number) {
    this.rows = this.rows.slice(0, n);
    return this;
  }

  offset(n: number) {
    this.rows = this.rows.slice(n);
    return this;
  }
}

export class FakeDb {
  /** Every write, in order, so tests can assert what the service persisted. */
  readonly writes: Array<{ kind: "insert" | "update"; table: TableRef; values: FakeRow }> = [];

  constructor(private readonly tables: Map<TableRef, FakeRow[]>) {}

  rowsFor(table: TableRef): FakeRow[] {
    return this.tables.get(table) ?? [];
  }

  select(_columns?: unknown) {
    return new SelectBuilder(this);
  }

  insert(table: TableRef) {
    return {
      values: (values: FakeRow) => {
        const inserted = { id: `row-${this.writes.length + 1}`, ...values };
        this.writes.push({ kind: "insert", table, values: inserted });
        const existing = this.tables.get(table);
        if (existing) existing.push(inserted);
        else this.tables.set(table, [inserted]);
        const result = new Thenable(() => [inserted]);
        return Object.assign(result, { returning: () => new Thenable(() => [inserted]) });
      }
    };
  }

  update(table: TableRef) {
    return {
      set: (values: FakeRow) => {
        this.writes.push({ kind: "update", table, values });
        const rows = this.rowsFor(table);
        for (const row of rows) Object.assign(row, values);
        return {
          where: (_condition: unknown) => {
            const result = new Thenable(() => undefined);
            return Object.assign(result, { returning: () => new Thenable(() => rows) });
          }
        };
      }
    };
  }

  /** Last value written to `column` on `table`, or undefined. */
  lastWrite(table: TableRef, column: string): unknown {
    for (let i = this.writes.length - 1; i >= 0; i -= 1) {
      const write = this.writes[i]!;
      if (write.table === table && column in write.values) return write.values[column];
    }
    return undefined;
  }
}

/** Redis stub — the interview service only uses it for the scene-diff hash. */
export const fakeRedis = {
  async get() {
    return null;
  },
  async set() {
    return "OK";
  }
};
