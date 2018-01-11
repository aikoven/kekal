import {Permanent} from './permanent';

interface EmptyDeferred {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: any): void;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: any): void;
}

function defer(): EmptyDeferred;
function defer<T>(): Deferred<T>;
function defer<T>(): Deferred<T> {
  let resolve: (value?: T) => void;
  let reject: (reason: any) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {promise, resolve: resolve!, reject: reject!};
}

type ExecutorStep =
  | 'pre-startup'
  | 'startup exception'
  | 'post-startup'
  | 'yield exception'
  | 'pre-cleanup'
  | 'cleanup exception'
  | 'post-cleanup';

interface TestPermanent {
  permanent: Permanent<string>;
  getStep(): ExecutorStep;
  resolveStartup(): void;
  rejectStartup(reason: any): void;
  resolveCleanup(): void;
  rejectCleanup(reason: any): void;
  abort(reason: any): void;
}

function createTestPermanent(value: string = ''): TestPermanent {
  const startupDeferred = defer();
  const cleanupDeferred = defer();
  const abortDeferred = defer<string>();

  let step: ExecutorStep;

  const permanent = new Permanent<string>(async (yieldValue, abort) => {
    step = 'pre-startup';
    try {
      await startupDeferred.promise;
    } catch (e) {
      step = 'startup exception';
      throw e;
    }
    step = 'post-startup';

    abortDeferred.promise.then(abort);

    try {
      await yieldValue(value);
    } catch (e) {
      step = 'yield exception';
      throw e;
    }

    step = 'pre-cleanup';
    try {
      await cleanupDeferred.promise;
    } catch (e) {
      step = 'cleanup exception';
      throw e;
    }
    step = 'post-cleanup';
  });

  function getStep() {
    return step;
  }

  return {
    permanent,
    getStep,
    resolveStartup: startupDeferred.resolve,
    rejectStartup: startupDeferred.reject,
    resolveCleanup: cleanupDeferred.resolve,
    rejectCleanup: cleanupDeferred.reject,
    abort: abortDeferred.resolve,
  };
}

type PermanentState = 'pending' | 'live' | 'stopping' | 'stopped' | 'aborted';

function getState(permanent: Permanent<any>): PermanentState {
  return (permanent as any)._state.type;
}

interface PendingPromiseState {
  type: 'pending';
}
interface FinishedPromiseState {
  type: 'finished';
}
interface FailedPromiseState {
  type: 'failed';
  reason: any;
}
type PromiseState =
  | PendingPromiseState
  | FinishedPromiseState
  | FailedPromiseState;

function watchPromise(promise: Promise<void>): () => PromiseState {
  let state: PromiseState = {type: 'pending'};

  promise.then(
    () => {
      state = {type: 'finished'};
    },
    reason => {
      state = {type: 'failed', reason};
    },
  );

  return () => state;
}

const emptyStack = () => new Promise(resolve => setTimeout(resolve));

describe('permanent', () => {
  describe('join()', () => {
    test('rejects if startup failed', async () => {
      const testPerm = createTestPermanent();

      expect(testPerm.getStep()).toBe('pre-startup');

      testPerm.rejectStartup('reason');

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('startup exception');
    });

    test('rejects if executor was aborted while pending', async () => {
      const testPerm = createTestPermanent();

      expect(testPerm.getStep()).toBe('pre-startup');
      expect(getState(testPerm.permanent)).toBe('pending');

      testPerm.abort('reason');
      testPerm.resolveStartup();

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('yield exception');
    });

    test('rejects if executor was aborted while live', async () => {
      const testPerm = createTestPermanent();

      testPerm.resolveStartup();

      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('live');

      testPerm.abort('reason');

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('yield exception');
    });

    test('rejects if permanent was stopped while pending and cleanup failed', async () => {
      const testPerm = createTestPermanent();

      expect(testPerm.getStep()).toBe('pre-startup');
      expect(getState(testPerm.permanent)).toBe('pending');

      testPerm.permanent.stop();
      testPerm.resolveStartup();
      testPerm.rejectCleanup('reason');

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('cleanup exception');
    });

    test('rejects if permanent was stopped while live and cleanup failed', async () => {
      const testPerm = createTestPermanent();

      testPerm.resolveStartup();

      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('live');

      testPerm.permanent.stop();
      testPerm.rejectCleanup('reason');

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('cleanup exception');
    });

    test('resolves if permanent was stopped while pending and cleanup finished', async () => {
      const testPerm = createTestPermanent();

      expect(testPerm.getStep()).toBe('pre-startup');
      expect(getState(testPerm.permanent)).toBe('pending');

      testPerm.permanent.stop();
      testPerm.resolveStartup();
      testPerm.resolveCleanup();

      await expect(testPerm.permanent.join()).resolves.toBeUndefined();
    });

    test('resolves if permanent was stopped while live and cleanup finished', async () => {
      const testPerm = createTestPermanent();

      testPerm.resolveStartup();

      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('live');

      testPerm.permanent.stop();
      testPerm.resolveCleanup();

      await expect(testPerm.permanent.join()).resolves.toBeUndefined();
    });
  });

  describe('inside()', () => {
    test('returned promise resolves once permanent becomes live', async () => {
      const testPerm = createTestPermanent('the value');

      expect(testPerm.getStep()).toBe('pre-startup');
      expect(getState(testPerm.permanent)).toBe('pending');

      const promise = testPerm.permanent.inside(value => value);

      testPerm.resolveStartup();

      await expect(promise).resolves.toBe('the value');
    });

    test('returned promise resolves if permanent is already live', async () => {
      const testPerm = createTestPermanent('the value');

      testPerm.resolveStartup();

      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('live');

      const promise = testPerm.permanent.inside(value => value);

      await expect(promise).resolves.toBe('the value');
    });

    test('returned promise rejects if executor was aborted', async () => {
      const testPerm = createTestPermanent('the value');

      testPerm.abort('reason');
      testPerm.resolveStartup();

      await expect(testPerm.permanent.join()).rejects.toBe('reason');
      expect(testPerm.getStep()).toBe('yield exception');
      expect(getState(testPerm.permanent)).toBe('aborted');

      const promise = testPerm.permanent.inside(value => value);

      await expect(promise).rejects.toBe('reason');
    });

    test('returned promise rejects if permanent was stopped', async () => {
      const testPerm = createTestPermanent();

      testPerm.resolveStartup();
      testPerm.permanent.stop();
      testPerm.resolveCleanup();
      await emptyStack();

      expect(testPerm.getStep()).toBe('post-cleanup');
      expect(getState(testPerm.permanent)).toBe('stopped');

      const promise = testPerm.permanent.inside(value => value);

      await expect(promise).rejects.toThrow('permanent stopped');
    });

    test('permanent stays in stopping state while there are pending tasks', async () => {
      const testPerm = createTestPermanent('the value');

      testPerm.resolveStartup();

      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('live');

      const deferred1 = defer<string>();
      const deferred2 = defer();

      const promise1 = testPerm.permanent.inside(value =>
        deferred1.promise.then(d => `${value} ${d}`),
      );
      const promise2 = testPerm.permanent.inside(value => deferred2.promise);

      testPerm.permanent.stop();
      await emptyStack();

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('stopping');

      await expect(testPerm.permanent.inside(value => value)).rejects.toThrow(
        'permanent stopped',
      );

      deferred1.resolve('1');

      await expect(promise1).resolves.toBe('the value 1');

      expect(testPerm.getStep()).toBe('post-startup');
      expect(getState(testPerm.permanent)).toBe('stopping');

      deferred2.reject('reason');

      await expect(promise2).rejects.toBe('reason');
      await emptyStack();

      expect(testPerm.getStep()).toBe('pre-cleanup');
      expect(getState(testPerm.permanent)).toBe('stopped');
    });
  });

  describe('child()', () => {
    test('returned permanent becomes live when this and child permanent become live', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      expect(getState(testPerm.permanent)).toBe('pending');
      expect(childPerm).toBeNull();
      expect(getState(res)).toBe('pending');

      testPerm.resolveStartup();
      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('live');
      expect(childPerm).not.toBeNull();
      expect(getState(childPerm!.permanent)).toBe('pending');
      expect(getState(res)).toBe('pending');

      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('live');
      expect(getState(res)).toBe('live');
    });

    test('returned permanent stops when this permanent is stopped while pending', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      const getParentJoinState = watchPromise(testPerm.permanent.join());
      const getJoinState = watchPromise(res.join());

      testPerm.permanent.stop();
      testPerm.resolveStartup();

      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('stopped');
      expect(getState(res)).toBe('stopped');
      expect(getParentJoinState().type).toBe('pending');
      expect(getJoinState().type).toBe('finished');
    });

    test('returned permanent stops when this permanent is stopped while live', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      const getJoinState = watchPromise(res.join());

      testPerm.resolveStartup();
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('live');
      expect(getState(res)).toBe('live');

      testPerm.permanent.stop();

      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('stopping');
      expect(getState(res)).toBe('stopped');
      expect(getJoinState().type).toBe('pending');

      childPerm!.resolveCleanup();

      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('stopped');
      expect(getState(res)).toBe('stopped');
      expect(getJoinState().type).toBe('finished');
    });

    test('returned permanent aborts when this permanent is aborted while pending', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      const getJoinState = watchPromise(res.join());

      expect(getState(testPerm.permanent)).toBe('pending');
      expect(getState(res)).toBe('pending');

      testPerm.abort('reason');
      testPerm.resolveStartup();

      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('aborted');
      expect(getState(res)).toBe('aborted');
      expect(getJoinState()).toEqual({type: 'failed', reason: 'reason'});
    });

    test('returned permanent aborts when this permanent is aborted while live', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      const getJoinState = watchPromise(res.join());

      testPerm.resolveStartup();
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('live');
      expect(getState(res)).toBe('live');

      testPerm.abort('reason');

      await emptyStack();

      expect(getState(testPerm.permanent)).toBe('aborted');
      expect(getState(res)).toBe('aborted');
      expect(getJoinState()).toEqual({type: 'failed', reason: 'reason'});
    });

    test('returned permanent stops when child permanent is stopped while pending', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      testPerm.resolveStartup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('pending');
      expect(getState(res)).toBe('pending');

      childPerm!.permanent.stop();
      childPerm!.resolveStartup();

      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('stopped');
      expect(getState(res)).toBe('stopped');
      expect(getState(testPerm.permanent)).toBe('live');
    });

    test('returned permanent stops when child permanent is stopped while live', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      testPerm.resolveStartup();
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('live');
      expect(getState(res)).toBe('live');

      // block resulting permanent from stopping
      const resBlock = defer();
      res.inside(() => resBlock.promise);

      childPerm!.permanent.stop();

      expect(getState(childPerm!.permanent)).toBe('stopping');
      expect(getState(res)).toBe('stopping');

      childPerm!.resolveCleanup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('stopping');
      expect(getState(res)).toBe('stopping');

      resBlock.resolve();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('stopped');
      expect(getState(res)).toBe('stopped');
    });

    test('child permanent stops when returned permanent is stopped', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      testPerm.resolveStartup();
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(res)).toBe('live');

      res.stop();

      expect(getState(res)).toBe('stopping');
      expect(getState(childPerm!.permanent)).toBe('live');

      await emptyStack();

      expect(getState(res)).toBe('stopped');
      expect(getState(childPerm!.permanent)).toBe('stopped');
    });

    test('returned permanent aborts when child permanent is aborted while pending', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      testPerm.resolveStartup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('pending');
      expect(getState(res)).toBe('pending');

      childPerm!.abort('reason');
      childPerm!.resolveStartup();

      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('aborted');
      expect(getState(res)).toBe('aborted');
      expect(getState(testPerm.permanent)).toBe('live');
      expect(res.join()).rejects.toBe('reason');
    });

    test('returned permanent aborts when child permanent is aborted while live', async () => {
      const testPerm = createTestPermanent('the value');

      let childPerm: TestPermanent | null = null;

      const res = testPerm.permanent.child(value => {
        childPerm = createTestPermanent(`${value} child`);
        return childPerm.permanent;
      });

      testPerm.resolveStartup();
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('live');
      expect(getState(res)).toBe('live');

      childPerm!.abort('reason');

      await emptyStack();

      expect(getState(childPerm!.permanent)).toBe('aborted');
      expect(getState(res)).toBe('aborted');
      expect(getState(testPerm.permanent)).toBe('live');
      expect(res.join()).rejects.toBe('reason');
    });
  });

  describe('all()', () => {
    test('returned permanent becomes live when all source permanents become live', async () => {
      const testPerms = [
        createTestPermanent('first'),
        createTestPermanent('second'),
        createTestPermanent('third'),
      ];

      const res = Permanent.all(testPerms.map(p => p.permanent));

      expect(getState(res)).toBe('pending');

      testPerms[0].resolveStartup();
      await emptyStack();

      expect(getState(testPerms[0].permanent)).toBe('live');
      expect(getState(res)).toBe('pending');

      testPerms[1].resolveStartup();
      testPerms[2].resolveStartup();
      await emptyStack();

      expect(getState(res)).toBe('live');

      await expect(res.inside(value => value)).resolves.toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    test('returned permanent stops when any source permanent is stopped', async () => {
      const testPerms = [
        createTestPermanent('first'),
        createTestPermanent('second'),
        createTestPermanent('third'),
      ];

      const res = Permanent.all(testPerms.map(p => p.permanent));

      for (const testPerm of testPerms) {
        testPerm.resolveStartup();
      }
      await emptyStack();

      expect(getState(res)).toBe('live');

      testPerms[0].permanent.stop();
      await emptyStack();

      expect(getState(testPerms[0].permanent)).toBe('stopped');
      expect(getState(testPerms[1].permanent)).toBe('live');
      expect(getState(testPerms[2].permanent)).toBe('live');

      expect(getState(res)).toBe('stopped');
    });

    test('returned permanent aborts when any source permanent is aborted', async () => {
      const testPerms = [
        createTestPermanent('first'),
        createTestPermanent('second'),
        createTestPermanent('third'),
      ];

      const res = Permanent.all(testPerms.map(p => p.permanent));

      for (const testPerm of testPerms) {
        testPerm.resolveStartup();
      }
      await emptyStack();

      expect(getState(res)).toBe('live');

      testPerms[0].abort('reason');
      await emptyStack();

      expect(getState(testPerms[0].permanent)).toBe('aborted');
      expect(getState(testPerms[1].permanent)).toBe('live');
      expect(getState(testPerms[2].permanent)).toBe('live');

      expect(getState(res)).toBe('aborted');
      await expect(res.join()).rejects.toBe('reason');
    });

    test('source permanents do not stop when returned permanent is stopped', async () => {
      const testPerms = [
        createTestPermanent('first'),
        createTestPermanent('second'),
        createTestPermanent('third'),
      ];

      const res = Permanent.all(testPerms.map(p => p.permanent));

      for (const testPerm of testPerms) {
        testPerm.resolveStartup();
      }
      await emptyStack();

      expect(getState(res)).toBe('live');

      res.stop();
      await emptyStack();

      expect(getState(res)).toBe('stopped');

      for (const testPerm of testPerms) {
        expect(getState(testPerm.permanent)).toBe('live');
      }
    });

    test('source permanents do not abort when child permanent is aborted', async () => {
      const testPerms = [
        createTestPermanent('first'),
        createTestPermanent('second'),
        createTestPermanent('third'),
      ];

      let childPerm: TestPermanent | null = null;

      const res = Permanent.all(testPerms.map(p => p.permanent)).child(
        values => {
          childPerm = createTestPermanent(values.join(' '));
          return childPerm.permanent;
        },
      );

      for (const testPerm of testPerms) {
        testPerm.resolveStartup();
      }
      await emptyStack();
      childPerm!.resolveStartup();
      await emptyStack();

      expect(getState(res)).toBe('live');

      childPerm!.abort('reason');
      await emptyStack();

      expect(getState(res)).toBe('aborted');
      await expect(res.join()).rejects.toBe('reason');

      for (const testPerm of testPerms) {
        expect(getState(testPerm.permanent)).toBe('live');
      }
    });
  });
});
