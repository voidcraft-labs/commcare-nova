#!/usr/bin/env node

import { execSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Skip if explicitly disabled
if (process.env.NOVA_SKIP_UPDATE_CHECK === '1') process.exit(0)

const isTTY = process.stdin.isTTY && process.stdout.isTTY
const useColor = isTTY && !process.env.NO_COLOR

// ANSI helpers
const cyan = (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s)
const yellow = (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s)
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s)
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s)

function git(args, { timeout = 5000 } = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.error) return null
  return (result.stdout || '').trim()
}

function silentExit() {
  process.exit(0)
}

// --- Preflight ---

// Verify git exists and we're in a repo
if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') silentExit()

// Verify origin remote exists
const remotes = git(['remote'])
if (!remotes || !remotes.split('\n').includes('origin')) silentExit()

// Must be on main branch
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') silentExit()

// --- Fetch ---

if (git(['fetch', 'origin', 'main', '--quiet'], { timeout: 5000 }) === null) silentExit()

// --- Check distance ---

const countStr = git(['rev-list', '--count', 'HEAD..origin/main'])
const count = parseInt(countStr, 10)
if (!count || count === 0) silentExit()

// --- Gather info ---

const logOutput = git(['log', '--oneline', 'HEAD..origin/main'])
if (!logOutput) silentExit()
const allCommits = logOutput.split('\n').filter(Boolean)

const statusOutput = git(['status', '--porcelain']) ?? ''
const isDirty = statusOutput.length > 0

// --- Build display ---

const MAX_SHOWN = 5
const shown = allCommits.slice(0, MAX_SHOWN)
const remaining = count - shown.length

// Format commit lines
const commitLines = shown.map((line) => {
  const msg = line.replace(/^[a-f0-9]+ /, '')
  return `   ${cyan('●')} ${msg}`
})
if (remaining > 0) {
  commitLines.push(`   ${dim(`...and ${remaining} more`)}`)
}

// Build dirty-tree warning lines
const dirtyLines = isDirty
  ? [
      '',
      `   ${yellow('⚠')} ${yellow('You have uncommitted changes.')}`,
      `   Save your work first, then update:`,
      `     ${bold('1.')} git stash`,
      `     ${bold('2.')} git pull`,
      `     ${bold('3.')} git stash pop`,
    ]
  : []

// Measure box width
const commitWord = count === 1 ? 'commit' : 'commits'
const title = `   ${cyan('✦')} ${bold('Nova')} — ${count} new ${commitWord} available`

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

const allContentLines = ['', title, '', ...commitLines, ...dirtyLines, '']
const maxContentWidth = Math.max(...allContentLines.map((l) => stripAnsi(l).length))
const boxWidth = Math.max(maxContentWidth + 3, 50)

// Render box
const topBorder = cyan(`╭${'─'.repeat(boxWidth)}╮`)
const bottomBorder = cyan(`╰${'─'.repeat(boxWidth)}╯`)

console.log('')
console.log(topBorder)
for (const line of allContentLines) {
  const visible = stripAnsi(line).length
  const padding = ' '.repeat(Math.max(0, boxWidth - visible))
  console.log(`${cyan('│')}${line}${padding}${cyan('│')}`)
}
console.log(bottomBorder)
console.log('')

// --- Prompt or exit ---

if (isDirty || !isTTY) {
  // Dirty tree or non-interactive — no prompt
  process.exit(0)
}

// Interactive prompt
const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase())
    })
  })
}

const answer = await ask(`  Update now? ${dim('(y/n)')} `)
rl.close()

if (answer !== 'y' && answer !== 'yes') {
  console.log('')
  process.exit(0)
}

// --- Pull ---

// Hash package-lock before pull
const lockPath = join(process.cwd(), 'package-lock.json')
function hashFile(path) {
  if (!existsSync(path)) return null
  return createHash('md5').update(readFileSync(path)).digest('hex')
}

const lockHashBefore = hashFile(lockPath)

process.stdout.write(`  Pulling latest changes...`)
const pullResult = spawnSync('git', ['pull', 'origin', 'main'], {
  encoding: 'utf-8',
  timeout: 30000,
  stdio: ['pipe', 'pipe', 'pipe'],
})

if (pullResult.status !== 0) {
  console.log(` ${red('failed')}`)
  console.log(`  ${yellow('Could not pull automatically. Try manually:')}`)
  console.log(`    ${bold('git pull origin main')}`)
  console.log('')
  process.exit(0)
}

console.log(` ${green('done ✓')}`)

// --- Auto npm install if deps changed ---

const lockHashAfter = hashFile(lockPath)
if (lockHashBefore !== lockHashAfter) {
  process.stdout.write(`  Dependencies changed — installing...`)
  const installResult = spawnSync('npm', ['install'], {
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (installResult.status !== 0) {
    console.log(` ${red('failed')}`)
    console.log(`  ${yellow('Run')} ${bold('npm install')} ${yellow('manually.')}`)
  } else {
    console.log(` ${green('done ✓')}`)
  }
}

console.log('')
process.exit(0)
