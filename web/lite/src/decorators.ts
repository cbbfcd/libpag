export function destroyVerify(constructor: any) {
  let functions = Object.getOwnPropertyNames(constructor.prototype).filter(
    (name) => name !== 'constructor' && typeof constructor.prototype[name] === 'function',
  );

  const proxyFn = (target: { [prop: string]: any }, methodName: string) => {
    const fn = target[methodName];
    target[methodName] = function () {
      if (this['destroyed']) {
        console.error(`Don't call ${methodName} of the PAGView that is destroyed.`);
        return;
      }
      return fn.apply(this, arguments);
    };
  };
  functions.forEach((name) => proxyFn(constructor.prototype, name));
}
