import assert from 'node:assert/strict'
import test from 'node:test'
import {parseMarkedModelReport} from '../lib/model-report.mjs'

const report = {state:'needs-user',goalReached:false,reason:'No authorized page',marker:'SYNTHETIC_DONE'}

test('reads the marked report after unrelated JSON evidence', () => {
  const reply = 'The list returned {"tabs":[],"scope":"authorized-tabs"}.\n```json\n'+JSON.stringify(report)+'\n```'
  assert.deepEqual(parseMarkedModelReport(reply,report.marker),report)
})

test('keeps escaped quotes, braces and nested diagnostic data inside their JSON object', () => {
  const value = {...report,reason:'The text says "{unfinished}" and \\escaped',diagnostics:{values:['{','}']}}
  assert.deepEqual(parseMarkedModelReport(JSON.stringify(value),report.marker),value)
})

test('does not let malformed prose braces hide a valid report', () => {
  assert.deepEqual(parseMarkedModelReport('The label {unfinished\n'+JSON.stringify(report),report.marker),report)
})

test('rejects ambiguous marked reports instead of choosing a favorable answer', () => {
  assert.throws(()=>parseMarkedModelReport(JSON.stringify(report)+'\n'+JSON.stringify({...report,goalReached:true}),report.marker),/found 2/)
})

test('does not promote a report quoted inside another JSON value', () => {
  for (const quoted of [JSON.stringify({evidence:JSON.stringify(report),nested:report}),JSON.stringify([report])]) {
    assert.throws(()=>parseMarkedModelReport(quoted,report.marker),/found 0/)
  }
})

test('rejects a missing marker and bounds the scan of untrusted text', () => {
  assert.throws(()=>parseMarkedModelReport('{"goalReached":true}',report.marker),/found 0/)
  assert.throws(()=>parseMarkedModelReport('x'.repeat(131073),report.marker),/oversized/)
  assert.throws(()=>parseMarkedModelReport('{'.repeat(257),report.marker),/Too many/)
})
