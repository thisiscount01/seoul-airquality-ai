'use strict';
/**
 * brain-loader.js
 * brain.js는 headless Node.js에서 gpu.js(→ gl native addon)를 require 시 충돌.
 * NeuralNetwork(CPU 전용)만 사용하므로 gpu.js를 stub으로 대체 후 로드.
 */

const Module = require('module');
const origLoad = Module._load;

// brain.js 로드 전에 gpu.js stub 주입
Module._load = function (req, parent, isMain) {
  if (req === 'gpu.js') {
    // GPU/WebGL 없이도 NeuralNetwork(CPU) 가 정상 동작하도록 최소 stub
    class GPU {
      constructor() {}
      createKernel(fn) {
        const kernel = function () {};
        kernel.setOutput = () => kernel;
        kernel.setPipeline = () => kernel;
        kernel.setImmutable = () => kernel;
        return kernel;
      }
      destroy() {}
    }
    class Texture {}
    class Input {
      constructor(value, size) {
        this.value = value;
        this.size = size;
      }
    }
    return { GPU, Texture, Input };
  }
  return origLoad.call(this, req, parent, isMain);
};

const brain = require('brain.js'); // 로드 (gpu.js stub이 캐시됨)

// 복원: brain.js 이후 require는 정상 동작
Module._load = origLoad;

module.exports = brain;
