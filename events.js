"use strict"
/**
 * 运行生命周期事件（引擎 → 消费者）——Node EventEmitter 版。
 *
 * 旧版宿主的实现走 document 上的 CustomEvent；mdcode2run 是
 * 无 DOM 的引擎，呈现归宿主，事件只在引擎的 events（EventEmitter）上发。词汇不变：
 *
 *   started { family, line, surface }
 *   chunk   { family, line, stream, text }
 *   done    { family, line, ok, duration, error? }
 *
 * detail 里原带的 `el`（DOM 元素关联键）换成 `line`（块在源码中的开启行号）——
 * 消费者拿行号回自己的文档模型里找对应视图对象。
 */
const { EventEmitter } = require("events")

const createRunEvents = () => new EventEmitter()

module.exports = { createRunEvents }
