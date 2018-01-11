import assertNever from 'assert-never';

/**
 * @param yieldValue Called by the executor when the permanent value becomes
 *   available. Returns a promise that is resolved once the permanent is
 *   stopped and rejected when it is aborted.
 *   Calling `yieldValue` more than once is an error.
 * @param abort Called by the executor when the permanent fails.
 *   Calling `abort` more than once is a no-op.
 */
export interface Executor<T> {
  (
    yieldValue: (value?: T) => Promise<void>,
    abort: (reason: any) => void,
  ): Promise<void>;
}

export class Permanent<T> {
  /**
   * Create a permanent from given value.
   */
  static of<T>(value: T): Permanent<T> {
    return new Permanent(yieldValue => yieldValue(value));
  }

  /**
   * For given binary function acting on plain values return equivalent
   * function acting on permanents.
   */
  static lift2<X, Y, R>(fn: (x: X, y: Y) => R) {
    return (px: Permanent<X>, py: Permanent<Y>): Permanent<R> => {
      return px.child(x => py.child(y => Permanent.of(fn(x, y))));
    };
  }

  /**
   * Create a permanent that yields an array of values from each input
   * permanent.
   *
   * Returned permanent stops or aborts when any input permanent is stopped or
   * aborted.
   */
  static all<T1, T2, T3, T4, T5>(
    permanents: [
      Permanent<T1>,
      Permanent<T2>,
      Permanent<T3>,
      Permanent<T4>,
      Permanent<T5>
    ],
  ): Permanent<[T1, T2, T3, T4, T5]>;
  static all<T1, T2, T3, T4>(
    permanents: [Permanent<T1>, Permanent<T2>, Permanent<T3>, Permanent<T4>],
  ): Permanent<[T1, T2, T3, T4]>;
  static all<T1, T2, T3>(
    permanents: [Permanent<T1>, Permanent<T2>, Permanent<T3>],
  ): Permanent<[T1, T2, T3]>;
  static all<T1, T2>(
    permanents: [Permanent<T1>, Permanent<T2>],
  ): Permanent<[T1, T2]>;
  static all<T>(permanents: Permanent<T>[]): Permanent<T[]>;
  static all(permanents: any[]) {
    return permanents.reduce(permanentAppend, Permanent.of<any[]>([]));
  }

  /**
   * When any of given permanents is stopped or aborted, stops all other
   * permanents.
   *
   * Returns a promise that resolves once all permanents stop and rejects if any
   * of them aborts.
   *
   * Accepts optional callback that is called with the `stop` function that
   * stops all permanents.
   */
  static joinAll(
    permanents: Permanent<any>[],
    cb?: (stop: () => void) => void,
  ): Promise<void> {
    function stopAll() {
      for (const permanent of permanents) {
        permanent.stop();
      }
    }

    if (cb) {
      cb(stopAll);
    }

    const promises = permanents.map(p => p.join());

    Promise.race(promises).then(stopAll, stopAll);

    return Promise.all(promises).then(noop);
  }

  /**
   * Create a permanent from executor function.
   *
   * @example
   *
   *    const connectionPerm = new Permanent(async (yieldValue, abort) => {
   *      const connection = await connect();
   *      connection.on('error', abort);
   *
   *      await yieldValue(connection);
   *
   *      connection.close();
   *    });
   */
  constructor(executor: Executor<T>) {
    const abort = this._abort.bind(this);
    this._promise = executor(this._yieldValue.bind(this), abort);
    this._promise.then(this.stop.bind(this), abort);
  }

  private _promise: Promise<void>;

  private _state: PermanentState<T> = {type: 'pending', scheduledFuncs: []};

  private _yieldValue(value: T) {
    switch (this._state.type) {
      case 'pending': {
        const beforeStopTasks: Array<(cb: () => void) => void> = [];

        for (const {fn, resolve} of this._state.scheduledFuncs) {
          const result = fn(value);

          if (isPromise(result)) {
            beforeStopTasks.push(cb => result.then(cb, cb));
          }

          resolve(result);
        }

        return new Promise<void>((resolveYield, rejectYield) => {
          this._state = {
            type: 'live',
            value,
            beforeStopTasks,
            abortTasks: [],
            resolveYield,
            rejectYield,
          };
        });
      }
      case 'aborted':
        return Promise.reject(this._state.reason);
      case 'live':
      case 'stopping':
        throw new Error('`yieldValue` called more than once');
      case 'stopped':
        return Promise.resolve();
      default:
        return assertNever(this._state);
    }
  }

  private _abort(reason: any) {
    switch (this._state.type) {
      case 'aborted':
      case 'stopped':
        return;
      case 'pending': {
        for (const {reject} of this._state.scheduledFuncs) {
          reject(reason);
        }
        this._state = {type: 'aborted', reason};
        return;
      }
      case 'live':
        for (const fn of this._state.abortTasks) {
          fn(reason);
        }
        this._state.rejectYield(reason);
        this._state = {type: 'aborted', reason};
        return;
      case 'stopping':
        this._state.rejectYield(reason);
        this._state = {type: 'aborted', reason};
        return;
      default:
        return assertNever(this._state);
    }
  }

  /**
   * Return a promise that resolves once the permanent successfully stops and
   * performs its cleanup and rejects if it aborts.
   *
   * This is the same promise that is returned from the executor.
   */
  join(): Promise<void> {
    return this._promise;
  }

  /**
   * Stop a permanent.
   * Note that the promise returned from `join` resolves only after a possibly
   * async cleanup has finished.
   *
   * Return a promise that resolves once all inside functions and child
   * permanents have finished and cleanup is about to start.
   */
  stop(): Promise<void> {
    switch (this._state.type) {
      case 'pending': {
        for (const {reject} of this._state.scheduledFuncs) {
          reject(new StoppedError('permanent stopped before yielding'));
        }
        this._state = {type: 'stopped'};
        return Promise.resolve();
      }
      case 'live': {
        const {beforeStopTasks, resolveYield, rejectYield} = this._state;

        this._state = {type: 'stopping', resolveYield, rejectYield};

        return Promise.all(beforeStopTasks.map(fn => new Promise(fn))).then(
          () => {
            if (this._state.type === 'stopping') {
              this._state.resolveYield();
              this._state = {type: 'stopped'};
            }
          },
        );
      }
      case 'stopping':
      case 'stopped':
      case 'aborted':
        return Promise.resolve();
      default:
        return assertNever(this._state);
    }
  }

  /**
   * Call given function on permanent's value when it becomes available.
   * The permanent is blocked from stopping until all inside functions finish.
   *
   * Returned promise rejects if the permanent is already stopped or aborted
   * or stops before yielding its value.
   */
  inside<R>(fn: (value: T) => R | PromiseLike<R>): Promise<R> {
    switch (this._state.type) {
      case 'pending':
        return new Promise<R>((resolve, reject) => {
          this._state = {
            type: 'pending',
            scheduledFuncs: [
              ...(this._state as PendingState<T>).scheduledFuncs,
              {fn, resolve, reject},
            ],
          };
        });
      case 'live': {
        const result = fn(this._state.value);

        if (isPromise(result)) {
          this._state.beforeStopTasks.push(cb => result.then(cb, cb));
        }

        return Promise.resolve(result);
      }
      case 'stopping':
      case 'stopped':
        return Promise.reject(new StoppedError('permanent stopped'));
      case 'aborted':
        return Promise.reject(this._state.reason);
      default:
        return assertNever(this._state);
    }
  }

  /**
   * Create a child permanent from the value of this permanent when it becomes
   * available.
   *
   * When this permanent is stopped or aborted, the child permanent is stopped
   * or aborted too.
   *
   * Stopping child permanent doesn't stop this permanent.
   */
  child<R>(fn: (value: T) => Permanent<R>): Permanent<R> {
    const perm = new Permanent<R>((yieldValue, abort) => {
      return this.inside(identity)
        .then(value => {
          if (!checkLiveState(this._state)) {
            throw new StoppedError('parent stopped');
          }

          const childPerm = fn(value);

          this._state.beforeStopTasks.push(cb => {
            childPerm.stop();
            childPerm.join().then(cb, cb);
          });
          this._state.abortTasks.push(reason => childPerm._abort(reason));

          return childPerm
            .inside(identity)
            .then(childValue => {
              if (!checkLiveState(childPerm._state)) {
                throw new StoppedError('child stopped');
              }

              childPerm._state.beforeStopTasks.push(cb => {
                perm.stop().then(cb);
              });
              childPerm._state.abortTasks.push(abort);

              return yieldValue(childValue);
            })
            .then(() => {
              childPerm.stop();
              return childPerm.join();
            });
        })
        .catch(e => {
          if (e instanceof StoppedError) {
            return;
          }

          throw e;
        });
    });

    return perm;
  }
}

export class StoppedError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, StoppedError.prototype);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
}

function checkLiveState<V>(state: PermanentState<V>): state is LiveState<V> {
  switch (state.type) {
    case 'pending':
      throw new Error('wrong state');
    case 'stopping':
    case 'stopped':
      return false;
    case 'aborted':
      throw state.reason;
    case 'live':
      return true;
    default:
      return assertNever(state);
  }
}

interface InsideFunc<T, R> {
  fn: (value: T) => R | Promise<R>;
  resolve(result?: R | PromiseLike<R>): void;
  reject(reason: any): void;
}

/**
 * Before `yieldValue()`.
 */
interface PendingState<T> {
  type: 'pending';
  scheduledFuncs: Array<InsideFunc<T, {}>>;
}

/**
 * After `yieldValue()` and before `stop()`.
 */
interface LiveState<T> {
  type: 'live';
  value: T;
  beforeStopTasks: Array<(cb: () => void) => void>;
  abortTasks: Array<(reason: any) => void>;
  resolveYield(): void;
  rejectYield(reason: any): void;
}

/**
 * After `stop()` and before resolution of `yieldValue()`.
 */
interface StoppingState {
  type: 'stopping';
  resolveYield(): void;
  rejectYield(reason: any): void;
}

/**
 * After `stop()` and possibly before executor finish.
 */
interface StoppedState {
  type: 'stopped';
}

/**
 * After `abort()`.
 */
interface AbortedState {
  type: 'aborted';
  reason: any;
}

type PermanentState<T> =
  | PendingState<T>
  | LiveState<T>
  | StoppingState
  | StoppedState
  | AbortedState;

const identity = <T>(value: T) => value;
const noop = () => {};

function isPromise<T>(value: any): value is PromiseLike<T> {
  return value != null && typeof value.then === 'function';
}

const permanentAppend = Permanent.lift2<any[], any, any[]>((array, value) => [
  ...array,
  value,
]);
