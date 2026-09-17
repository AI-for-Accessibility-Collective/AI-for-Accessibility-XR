// task-request.test.ts — which utterances start a task, which script they
// pick, and what the prompt says for a task nobody wrote a script for.

import { describe, expect, test } from 'bun:test';
import { genericTask, GENERIC_TASK_ID, isTaskRequest } from '../src/skills/builtin/task-guide.ts';
import { composePrompt, taskBriefBlock } from '../src/skills/compose.ts';
import { matchesTask, type Task } from '../src/skills/types.ts';
import washingMachine from '../src/tasks/washing-machine.json';
import bill from '../src/tasks/bill.json';

const WASH = washingMachine as Task;
const BILL = bill as Task;

describe('isTaskRequest', () => {
  test.each([
    'help me start the dishwasher',
    'Can you help me set the microwave clock?',
    'help with the thermostat please',
    'how do I turn on the oven',
    'How do we reset the router?',
    'walk me through changing the vacuum bag',
    'talk me through it',
    'show me how to use this remote',
    'teach me to use the coffee machine',
    'what are the steps to defrost this',
    "I'd like to set a timer on the oven",
    'I need to connect the printer',
    'I need help with the kettle',
    'Hello? Can you help me start the washing machine? I want to wash my cottons at forty degrees.',
  ])('starts a task: %s', (t) => {
    expect(isTaskRequest(t)).toBe(true);
  });

  test.each([
    'what is in front of me',
    'what does the dial do',
    'is it on?',
    'how do I know if it is running?',
    'how do I tell which one is hot',
    'where is the soap',
    'does this help?',
    'thanks, that helps',
    'done',
    'repeat',
    'stop',
    'yes',
    'what does this say?',
    'tell me more',
  ])('is conversation: %s', (t) => {
    expect(isTaskRequest(t)).toBe(false);
  });
});

describe('matchesTask matches whole words', () => {
  test.each([
    'help me start the washing machine',
    'Can you help me with the laundry?',
    'put a wash on for me',
    'how do I start the wash',
    'I want to do the washing',
    'the washer is beeping',
    'start a wash cycle',
  ])('washing machine: %s', (t) => {
    expect(matchesTask(WASH, t)).toBe(true);
  });

  test.each([
    'help me start the dishwasher',
    'help me wash the car',
    'wash my hands',
    'where is my washcloth',
    'help me set the microwave clock',
  ])('not the washing machine: %s', (t) => {
    expect(matchesTask(WASH, t)).toBe(false);
  });

  test('bill task still matches its own words', () => {
    expect(matchesTask(BILL, 'help me understand this bill')).toBe(true);
    expect(matchesTask(BILL, 'what is this letter about')).toBe(true);
    expect(matchesTask(BILL, 'the billing is done')).toBe(false);
  });
});

describe('a task without a script', () => {
  test('carries the request as its goal, with nothing else', () => {
    const t = genericTask('  Help me set the microwave clock!  ');
    expect(t).toEqual({ id: GENERIC_TASK_ID, trigger: [], goal: 'Help me set the microwave clock', brief: [] });
  });

  test('its brief is the request itself, and says there is no manual', () => {
    const block = taskBriefBlock(genericTask('help me set the microwave clock'));
    expect(block).toContain('The wearer asked: "help me set the microwave clock"');
    expect(block).toMatch(/No manual is available/);
    expect(block).not.toMatch(/from its manual|Dispenser drawer/);
  });

  test('a scripted brief is unchanged', () => {
    const block = taskBriefBlock(WASH);
    expect(block).toMatch(/^TASK: The wearer wants to start a cottons wash at 40°C\. Facts about their appliance \(from its manual\):/);
    expect(block).toContain('- Dispenser drawer');
  });

  test('the profile block still lands after the brief', () => {
    const si = composePrompt({ task: genericTask('help me set the microwave clock'), profileBlock: 'USER PROFILE: one step' });
    expect(si.indexOf('The wearer asked')).toBeLessThan(si.indexOf('USER PROFILE'));
  });
});
