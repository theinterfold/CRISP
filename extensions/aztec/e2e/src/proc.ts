// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'

import { LOGS, STATE_FILE, WORK } from './config'

export const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)

  return promise
}

/** What survives between `up`, `round` and `down`: addresses, process ids, the files to restore. */
export type State = {
  pids: Record<string, number>
  /** Repo files the deploy scripts rewrite: their original contents, or `null` if the file did not exist. */
  snapshot: Record<string, string | null>
  [key: string]: unknown
}

export const loadState = (): State => {
  if (!existsSync(STATE_FILE)) return { pids: {}, snapshot: {} }

  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
}

export const saveState = (state: State): void => {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, `${JSON.stringify(state, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`)
}

export const logPath = (name: string) => join(LOGS, `${name}.log`)

/** The last `lines` lines of a log, for an error message. */
export const tail = (name: string, lines = 30): string => {
  try {
    return readFileSync(logPath(name), 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; logName?: string; input?: string; allowFailure?: boolean }

/** Run a command to completion with its output in `logs/<logName>.log`; throws with the log tail on a non-zero exit. */
export const run = (command: string, args: string[], options: RunOptions = {}): { status: number; stdout: string } => {
  mkdirSync(LOGS, { recursive: true })
  const logName = options.logName ?? `${command.split('/').pop()}-${args[0] ?? ''}`.replace(/[^\w.-]/g, '_')
  const out = openSync(logPath(logName), 'a')
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', out, out],
  })
  closeSync(out)
  const status = result.status ?? 1
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`\`${command} ${args.join(' ')}\` exited with ${status}; see ${logPath(logName)}\n${tail(logName)}`)
  }

  return { status, stdout: tail(logName, 200) }
}

/** Start a long-lived process in its own process group; its pid is recorded so a later `down` can stop it. */
export const startDaemon = (
  state: State,
  name: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): number => {
  mkdirSync(LOGS, { recursive: true })
  const out = openSync(logPath(name), 'w')
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  closeSync(out)
  if (!child.pid) throw new Error(`Could not start ${name}`)
  state.pids[name] = child.pid
  saveState(state)

  return child.pid
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

export const isRunning = (state: State, name: string): boolean => {
  const pid = state.pids[name]

  return pid !== undefined && alive(pid)
}

/** SIGTERM a daemon's whole process group, then SIGKILL what is left after `graceMs`. */
export const stopDaemon = async (state: State, name: string, graceMs = 5000): Promise<void> => {
  const pid = state.pids[name]
  if (pid === undefined) return
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (alive(pid) && Date.now() < deadline) await sleep(200)
  if (alive(pid)) signal('SIGKILL')
  delete state.pids[name]
  saveState(state)
}

export const portOpen = (port: number, host = '127.0.0.1'): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = createConnection({ port, host })
  socket.once('connect', () => {
    socket.destroy()
    resolve(true)
  })
  socket.once('error', () => resolve(false))
  socket.setTimeout(1000, () => {
    socket.destroy()
    resolve(false)
  })

  return promise
}

export const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  options: { timeoutMs: number; intervalMs?: number; onTick?: () => void },
): Promise<T> => {
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`)
    }
    options.onTick?.()
    await sleep(options.intervalMs ?? 1000)
  }
}

export const workDir = (...parts: string[]) => {
  const dir = join(WORK, ...parts)
  mkdirSync(dir, { recursive: true })

  return dir
}
