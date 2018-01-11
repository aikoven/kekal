# Kekal

**Permanent** ([Malay](https://en.wikipedia.org/wiki/Malay_language): *kekal*)
is an abstraction for a long-lived process that can be stopped manually or
aborted due to an error.

Possible use cases are connections, subscriptions, locks etc.

## Installation

    $ npm install kekal

## Example

```js
import {Permanent} from 'kekal';

const connectionPermanent = new Permanent(async (yieldValue, abort) => {
  // perform asynchronous initialization
  const connection = await connect(...);
  // register error handler
  connection.on('error', abort);

  // yield it to the world
  // will block on this line until stopped or aborted
  await yieldValue(connection);

  // perform asynchronous cleanup
  await connection.close();
});

// run some function on permanent's value when it becomes available
const result = await connectionPermanent.inside(
  connection => connection.doSomeWork()
);

// create a child permanent that is bound to parent's execution
const subscriptionPermanent = connectionPermanent.child(
  connection => new Permanent(async (yieldValue, abort) => {
    const subscription = await connection.subscribe({
      ...,
      onError: abort,
    });

    await yieldValue();

    subscription.stop();
  })
);

// releases `yieldValue` to do a cleanup
connectionPermanent.stop();
// resolves if cleanup succeeds
await connectionPermanent.join();
```

## API

* `Permanent.of<T>(value: T): Permanent<T>`

  Create a permanent from given value.

* `Permanent.lift2<X, Y, R>(fn: (x: X, y: Y) => R): (px: Permanent<X>, py: Permanent<Y>) => Permanent<R>`

  For given binary function acting on plain values returns equivalent
  function acting on permanents.

* `Permanent.all<T1, ..., Tn>(permanents: [Permanent<T1>, ..., Permanent<Tn>]): Permanent<[T1, ..., Tn]>`

  Create a permanent that yields an array of values from each input
  permanent.

  Returned permanent stops or aborts when any input permanent is stopped or
  aborted.

* `Permanent.joinAll(permanents: Permanent<any>[], cb?: (stop: () => void) => void): Promise<void>`

  When any of given permanents is stopped or aborted, stops all other
  permanents.

  Returns a promise that resolves once all permanents stop and rejects if any
  of them aborts.

  Accepts optional callback that is called with the `stop` function that
  stops all permanents.

* `new Permanent<T>(executor: Executor<T>)`

  Create a permanent from executor function.

* `type Executor<T> = (yieldValue: (value: T) => Promise<void>, abort: (reason: any) => void): Promise<void>`

  * `yieldValue`

    Called by the executor when the permanent value becomes
    available. Returns a promise that is resolved once the permanent is
    stopped and rejected when it is aborted.

    Calling `yieldValue` more than once is an error.
  * `abort`

    Called by the executor when the permanent fails.

    Calling `abort` more than once is a no-op.

* `join(): Promise<void>`

  Return a promise that resolves once the permanent successfully stops and
  performs its cleanup and rejects if it aborts.

  This is the same promise that is returned from the executor.

* `stop(): Promise<void>`

  Stop a permanent.

  Note that the promise returned from `join` resolves only after a possibly
  async cleanup has finished.

  Return a promise that resolves once all inside functions and child
  permanents have finished and cleanup is about to start.

* `inside<R>(fn: (value: T) => R | PromiseLike<R>): Promise<R>`

  Calls given function on permanent's value when it becomes available.

  The permanent is blocked from stopping until all inside functions finish.

  Returned promise rejects if the permanent is already stopped or aborted
  or stops before yielding its value.

* `child<R>(fn: (value: T) => Permanent<R>): Permanent<R>`

  Create a child permanent from the value of this permanent when it becomes
  available.

  When this permanent is stopped or aborted, the child permanent is stopped
  or aborted too.

  Stopping child permanent doesn't stop this permanent.
