// completion.test.ts — isCompletionReply against real walkthrough replies
// from seven Gemini models (2026-09-14 benchmark), plus hand-written traps.
// A false positive ends the task mid-take (Done stops advancing); a false
// negative leaves Done live after the wash is running.

import { describe, expect, test } from 'bun:test';
import { isCompletionReply } from '../src/skills/builtin/task-guide.ts';

const ENDINGS = [
  'That is everything. Your wash cycle has started, so you are all set.',
  'That is everything, and your wash is running now. You are all done!',
  'All done. The wash cycle is running now, so you are all set.',
  'Wonderful, your cotton wash is all set and running now.',
  'You are all done! Everything is running, so you can sit back and relax now.',
  'Wonderful, your cottons wash at forty degrees is all set and running. Enjoy your day!',
  'You are all done, so there are no more steps needed. You can sit back and relax!',
  'You are all set, your cottons wash is now running. Have a wonderful rest of your day.',
  'That is everything. Your wash is running, so you can sit back and relax now.',
  'There are no more steps. You are all done and your laundry is washing.',
  'That is everything. Your cottons wash is now running and you are all set.',
  'You are all finished, so you can just sit back and relax now.',
  'There are no more steps, your wash is successfully running.',
  'All done. Your clothes are washing now. Let me know if you need help with anything else.',
  'Wonderful. That is it, your wash has now started. Let me know if you need anything else.',
  'You are all set. The washing machine is running, so there are no more steps to do.',
  'Wonderful. That was the last step, and your wash is starting now. Let me know if you need anything else.',
  'You are all finished. The washing machine is running, so there are no more steps to take.',
  'Wonderful. Your washing machine is now started and you are all set.',
  'That is it. There are no more steps, so you can just let the machine run.',
  'You are completely finished. The washing machine is running, so you can go relax now.',
  "You're all set. The washing machine should be starting now.",
  'Wonderful. The machine should be starting now. Is there anything else I can help you with?',
  "It looks like you're all set. The washing machine is running.",
  'All done — it’s running.',
  "Great, you've started the wash.",
  'All set!',
  "You don't have to do anything more.",
  "There's nothing left to do.",
  'After you pressed Start, the wash is now running.',
];

const STEPS = [
  'I would be glad to help you with that. First, open the top-left drawer and put soap into the largest section. Tell me done when you are ready.',
  'Great job. Now, turn the big dial on the front until it points to Cottons. Just say done when you finish.',
  'Wonderful. Next, press the temperature button until the little screen shows forty. Say done when you see it.',
  'You are doing great. Now, press and hold the start button for two seconds until the light turns on.',
  "I can certainly help you with that. First, turn the big dial to Cottons, and let me know when you're done.",
  'I would be happy to help you with that. Please pull open the top-left drawer and put your soap into the biggest slot on the left. Tell me when you are done.',
  'Great job. Now turn the big dial at the top until it points to the Cottons setting. Let me know when you are done.',
  'You are doing great. Now press and hold the start button for two seconds until the light turns on. Tell me when you are done.',
  'I would love to help with that. Please turn the big dial to Cottons, and say done when ready.',
  'Wonderful. Close the drawer and tap the Temp button until the screen shows forty. Say done when ready.',
  'I would be happy to help with your laundry. First, turn the big dial on top to Cottons.',
  'Nice job. Now open the top left drawer and put your soap in the largest left section.',
  'Perfect. Press and hold the Start button for two seconds until its light comes on.',
  'I can certainly help you with your laundry today. First, pull open the top-left drawer to add your soap.',
  'Perfect, almost there. Press and hold the start button for two seconds until the light comes on.',
  "I can certainly help you with that. First, let's open the drawer on the top left.",
  'Great. Now, pour your soap into the largest compartment on the left side of that drawer.',
  'Wonderful. Go ahead and slide the drawer all the way closed now.',
  'Awesome. Now press and hold the start button for two seconds until the light comes on.',
  'Almost there. Press and hold the start button for about two seconds until the light comes on. Just say done when it starts.',
  'Hello. I would be happy to help you with that. First, put your soap in the largest section of the top left drawer. Just say done when you are ready for the next step.',
  'Great. Now, turn the big dial on the top to the Cottons setting. Let me know when that is done.',
  'Excellent. Finally, press and hold the start button for two seconds until the light comes on. Let me know when you are done.',
  'Perfect. Now, turn the big dial on top until it points to Cottons. Let me know when you finish.',
  'Yes, I can help with that. First, please put your laundry in the machine and close the door.',
  'Perfect. To start the wash, press and hold the Start button for about two seconds. You’ll see a light come on when it’s ready.',
  "Excellent. Now, press the temperature button until the display shows forty degrees. It's the button that changes the numbers on the screen.",
];

const TRAPS = [
  'Check that the machine is not running before you open the door.',
  'Is the machine running?',
  'Once the wash is running, you can relax.',
  "Perfect, you're all set for the next step. Turn the dial to Cottons.",
  "That's it! Now press the start button.",
  "Don't press start until you're done loading.",
  'Great, the drawer is closed. Now turn the dial.',
  "The machine hasn't started yet, so press and hold the start button.",
  'Nice, you are done with the drawer. Now turn the dial.',
  "Good, you're all set with the soap.",
  'Press and hold Start. You will know the wash has started when the light comes on.',
  "Don't open the door while the machine is running.",
  'Now that the clothes are loaded, press Start to get the cycle started.',
  'The machine has a Start button on the right that gets it running.',
  'Make sure the machine is running before you walk away.',
  "There's nothing else in the drawer, so close it.",
];

describe('isCompletionReply', () => {
  test.each(ENDINGS)('ends the task: %s', (reply) => {
    expect(isCompletionReply(reply)).toBe(true);
  });

  test.each(STEPS)('is a step, not an ending: %s', (reply) => {
    expect(isCompletionReply(reply)).toBe(false);
  });

  test.each(TRAPS)('trap stays a step: %s', (reply) => {
    expect(isCompletionReply(reply)).toBe(false);
  });
});
