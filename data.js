"use strict";
// ===================================================================
// data.js  -  static content for Train (loaded before the inline app script).
// Defines window.EXERCISE_LIBRARY, window.FORM, window.SESSION_TEMPLATES.
// No app state or logic here. Keep classic: no defer / async / type=module.
// ===================================================================
window.TRAIN_DATA_VERSION = '7.2';

// ===================================================================
// EXERCISE LIBRARY
// ===================================================================
window.EXERCISE_LIBRARY = {
  'ring-row': { name:'Ring Row', grip:'high', ladder:['Inverted Row (feet down)','Ring Row (feet elevated)','Archer Ring Row','Front Lever Tuck Row'], repRange:[5,8], sets:3, unit:'reps', reference:{ status:'video', cue:'Full range, slow eccentric. Control the bottom. Heel of palm over the ring, not the fingers.', muscles:['lats','rhomboids','biceps','rear delts'], mediaType:'youtube', videoId:'puz-5s7P_Kc', start:null, end:null, sourceLabel:'YouTube', fallbackUrl:'https://www.youtube.com/watch?v=puz-5s7P_Kc', checkedAt:'2026-06-09' } },
  'ring-pushup': { name:'Ring Push-Up', grip:'high', ladder:['Ring Push-Up','Ring Push-Up (feet elevated)','Ring Archer Push-Up','Ring Dip (partial)'], repRange:[5,8], sets:4, unit:'reps', reference:{ status:'text', cue:'Turn the rings out at the top. Elbows at 45 degrees.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'ring-support': { name:'Ring Support Hold', grip:'high', ladder:['Ring Support Hold','Ring Support (turned out)','Ring L-Sit Support','Ring Support + Slow Turn'], repRange:[15,30], sets:3, unit:'sec', reference:{ status:'text', cue:'Locked arms, rings turned out. Breathe.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'ring-curl': { name:'Ring Bicep Curl', grip:'high', ladder:['Ring Curl (steep angle)','Ring Curl (moderate)','Ring Curl (low angle)','Ring Curl (feet elevated)'], repRange:[8,12], sets:2, unit:'reps', reference:{ status:'text', cue:'Slow eccentric, strict body line.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'ring-pullup': { name:'Ring Pull-Up', grip:'high', ladder:['Ring Negative Pull-Up (5s)','Ring Pull-Up (band assist)','Ring Pull-Up','Ring L-Sit Pull-Up'], repRange:[3,6], sets:4, unit:'reps', reference:{ status:'text', cue:'Let the wrists rotate naturally. Dead hang to chest, slow negative.', mediaUrl:null, mediaType:null, sourceLabel:null } },

  'para-pushup': { name:'Parallette Push-Up', grip:'low', ladder:['Parallette Push-Up','Parallette Deficit Push-Up','Parallette Archer Push-Up','Parallette Planche Lean Push-Up'], repRange:[6,10], sets:3, unit:'reps', reference:{ status:'text', cue:'Neutral grip. Full depth past the handles.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'db-press': { name:'DB Floor Press', grip:'low', ladder:['DB Floor Press','DB Floor Press (slow ecc)','DB Floor Press (pause)','DB Single-Arm Floor Press'], repRange:[8,12], sets:3, unit:'reps', reference:{ status:'text', cue:'25lb DBs. Control the bottom, pause at the chest.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'ring-face-pull': { name:'Ring Face Pull', grip:'low', ladder:['Ring Y-Raise','Ring Face Pull','Ring Face Pull (feet up)','Ring Face Pull + Hold'], repRange:[8,12], sets:3, unit:'reps', reference:{ status:'text', cue:'Light angle. Strict form, squeeze the rear delts.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'ab-wheel': { name:'Ab Wheel Rollout', grip:'low', ladder:['Kneeling Partial Rollout','Kneeling Full Rollout','Kneeling Rollout + Pause','Standing Partial Rollout'], repRange:[5,10], sets:3, unit:'reps', reference:{ status:'text', cue:'Hollow body throughout. Do not let the lower back collapse.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'pike-pushup': { name:'Pike Push-Up', grip:'low', ladder:['Pike Push-Up','Pike Push-Up (elevated feet)','Parallette Pike Push-Up (deficit)','Wall HSPU Negative (5s)'], repRange:[5,8], sets:3, unit:'reps', reference:{ status:'text', cue:'Overhead pressing pattern. Head passes between the hands.', mediaUrl:null, mediaType:null, sourceLabel:null } },

  'jefferson-curl': { name:'Jefferson Curl', grip:'none', ladder:['BW Jefferson Curl','Light DB Jefferson Curl','DB Jefferson Curl (slow)','DB Jefferson Curl (deficit)'], repRange:[5,8], sets:3, unit:'reps', reference:{ status:'text', cue:'Light. Vertebra by vertebra. Never rush.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'glute-bridge': { name:'Glute-Ham Bridge', grip:'none', ladder:['Glute Bridge','Glute Bridge (feet elevated)','Single-Leg Glute Bridge','Single-Leg Bridge (elevated)'], repRange:[8,12], sets:3, unit:'reps', reference:{ status:'text', cue:'Drive through the heels. Squeeze at the top.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'single-leg-rdl': { name:'Single-Leg RDL', grip:'none', ladder:['BW Single-Leg RDL','DB Single-Leg RDL','DB SL RDL (slow ecc)','DB SL RDL (deficit)'], repRange:[6,10], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Hinge at the hip, not the back. Light touch on a wall for balance if needed.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'jump-rope': { name:'Jump Rope', grip:'none', ladder:['Jump Rope 20s on/off','Jump Rope 30s on/off','Jump Rope 40s on/off','Jump Rope 30s on/15s off'], repRange:[4,6], sets:1, unit:'rounds', reference:{ status:'text', cue:'Stay light on the feet. Sub hill sprints outdoors.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'hanging-knee-raise': { name:'Hanging Knee Raise', grip:'low', ladder:['Hanging Tuck Knee Raise','Hanging Knee Raise','Hanging Knee Raise (slow)','Hanging Leg Raise'], repRange:[6,12], sets:3, unit:'reps', reference:{ status:'text', cue:'From a ring hang. Controlled negative, no swinging. Decompresses the spine after hinge work.', mediaUrl:null, mediaType:null, sourceLabel:null } },

  'pushup': { name:'Push-Up', grip:'none', ladder:['Push-Up'], repRange:[8,20], sets:3, unit:'reps', reference:{ status:'text', cue:'One standard: chest low, full lockout. Honest RPE 7–8.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'reverse-lunge': { name:'Reverse Lunge', grip:'none', ladder:['Reverse Lunge'], repRange:[8,15], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Step back, knee kisses the floor, drive up tall. Honest RPE 7–8.', mediaUrl:null, mediaType:null, sourceLabel:null } },

  'split-squat': { name:'Bulgarian Split Squat', grip:'none', ladder:['BW Split Squat','Bulgarian Split Squat','DB Bulgarian Split Squat','DB BSS (pause at bottom)'], repRange:[6,10], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Rear foot on a bench or box. Upright torso.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'step-lunge': { name:'Step-Through Lunge', grip:'none', ladder:['Reverse Lunge','Step-Through Lunge','Step-Through + Balance Hold','Step-Through + Hop'], repRange:[6,10], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Balance pause at the top of each rep.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'cossack-squat': { name:'Cossack Squat', grip:'none', ladder:['Supported Cossack Squat','Cossack Squat','Cossack Squat (slow tempo)','Weighted Cossack Squat'], repRange:[5,8], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Lateral plane. Heel stays planted. Go only as deep as you can control.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'calf-raise': { name:'Calf Raises', grip:'none', ladder:['Bilateral Calf Raise','Slow Bilateral (3s up/3s down)','Single-Leg Calf Raise','Single-Leg Slow Calf Raise'], repRange:[12,20], sets:2, unit:'reps', reference:{ status:'text', cue:'Full ROM. Pause at the top and bottom.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'hollow-body': { name:'Hollow Body Hold', grip:'none', ladder:['Tuck Hollow Hold','Single-Leg Hollow Hold','Hollow Body Hold','Hollow Body Rock'], repRange:[20,40], sets:3, unit:'sec', reference:{ status:'text', cue:'Lower back glued to the floor. Breathe.', mediaUrl:null, mediaType:null, sourceLabel:null } }
};

// ===================================================================
// THE FORM  (fixed universal mobility kata — one in-app card, v7.2)
// breath = the visible pacing line (the kata is paced in breaths, not seconds).
// detail = plain-language teaching text (beginner vocabulary, approved 2026-08-16).
// reference = Dane-approved demo (video embed or open-in-browser link). NOT logged as sets.
// ===================================================================
window.FORM = {
  name: 'Form',
  screens: [
    { id:'f1', title:'Root &amp; Prepare', breath:'Three slow breaths · shift weight on the exhale', cue:'Begin standing. Feet planted, hands rise from the sides.', movements:[
      { name:'Root + Breath + Weight Shift', detail:'Stand easy, feet under your hips. Spread your toes and feel the whole sole of each foot — front pad, outside edge, heel. Three slow breaths, rocking your weight gently side to side, so slow you never wobble.' },
      { name:'Wrist + Hand Wave → Centerline', detail:'Circle your wrists, open and close your hands, wake the fingers. Finish with your hands resting at the center of your chest, elbows heavy.' },
      { name:'Neck + Scapular Setting', detail:'Gentle neck circles. Let your shoulders drop away from your ears, collarbones wide.' }
    ]},
    { id:'f2', title:'Spinal Wave', breath:'Exhale into each reach · five per direction', cue:'Stay tall. Let the reach grow out of quiet shoulders.',
      reference:{ status:'video', mediaType:'youtube', videoId:'xtj4dmVtP8I', start:null, end:null, sourceLabel:'YouTube', fallbackUrl:'https://www.youtube.com/watch?v=xtj4dmVtP8I', checkedAt:'2026-08-16' },
      movements:[
      { name:'Spinal Wave', detail:'Arms overhead. Lean left, lean right, then turn your upper body each way — slow, like moving through honey. You are feeling your spine lengthen and bend one piece at a time, not reaching far.' }
    ]},
    { id:'f3', title:'Low Lunge + Reach', breath:'Descend on the exhale · 3–5 breaths per side', cue:'Step one foot back slowly; descend with the exhale.', movements:[
      { name:'Low Lunge + Reach', detail:'Step one foot far back, sink your hips down and forward until the front of the back leg’s hip stretches. Reach that same-side arm to the ceiling. A little deeper on each exhale, then switch sides.' }
    ]},
    { id:'f4', title:'Deep Squat Pry', breath:'Breathe into the bottom · pry on the exhale · 5–6 breaths', cue:'Bring the front foot in to meet the other; sink into the bottom.',
      reference:{ status:'link', url:'https://www.muscleandstrength.com/exercises/deep-squat-prying', sourceLabel:'Muscle & Strength', checkedAt:'2026-08-16' },
      movements:[
      { name:'Deep Squat Pry', detail:'Feet wide, toes slightly out, sit all the way down into your deepest squat, heels on the floor. Elbows rest inside your knees and gently push them apart. Shift around down there — exploring the position, never straining.' }
    ]},
    { id:'f5', title:'90/90 Flow', breath:'Exhale through each transition · five per side', cue:'Lower the seat to the floor; roll through one side, do not collapse back.', movements:[
      { name:'90/90 Flow', detail:'Sit with both knees bent at right angles — one leg in front, one to the side. Sweep both knees together over to the other side and sit tall again. Slow and controlled, exhaling as the knees travel.' }
    ]},
    { id:'f6', title:'Hollow ↔ Arch', breath:'Exhale into tension · cross on the inhale · 3–5 crossings', cue:'Settle onto the back; organize hollow before adding tension.',
      reference:{ status:'video', mediaType:'youtube', videoId:'0yPin8hSc8o', start:null, end:null, sourceLabel:'YouTube', fallbackUrl:'https://www.youtube.com/watch?v=0yPin8hSc8o', checkedAt:'2026-08-16' },
      movements:[
      { name:'Hollow ↔ Arch Tension', detail:'On your back: press your lower back into the floor, lift shoulders and legs slightly, arms by your ears — a shallow, tight banana. Roll to your belly and reverse it: chest and thighs lift, back squeezes. Move between the shapes slowly.' }
    ]},
    { id:'f7', title:'Bow &amp; Close', breath:'Fold on a long exhale · rise on the inhale · three closing breaths', cue:'Press to hands and knees, rise slowly, then stack up into the bow.',
      reference:{ status:'video', mediaType:'youtube', videoId:'BGQ-1Uptah8', start:null, end:null, sourceLabel:'YouTube', fallbackUrl:'https://www.youtube.com/watch?v=BGQ-1Uptah8', checkedAt:'2026-08-16' },
      movements:[
      { name:'Jefferson Curl / Bow', detail:'Tuck your chin and roll down toward your toes one vertebra at a time, head heavy, knees soft. Roll back up just as slowly, stacking your spine from the bottom. Five slow reps, no weight.' },
      { name:'Closing Reach + Breath', detail:'Reach both arms overhead, pause, and let the arms float down on one long exhale. Three times. That is the close — it marks the kata done.' }
    ]}
  ]
};

// ===================================================================
// SESSION TEMPLATES (working blocks; the Form replaces the old mobility primer)
// ===================================================================
// v7 ELASTIC SESSIONS: core/gate flags are EXPLICIT per block (never inferred from
// block.type — the LP/LS Ring Opener is typed 'finisher', same as real finishers).
//   core:true  = part of the guided Core path (before the Finish / Keep going fork)
//   gate:true  = counts toward coreComplete (the machine gate: every set of every gate
//                exercise logged with reps > 0). Kata/openers are core path, not gate.
// The MVS Floor day (noForm) is a distinct minimum-dose day: no kata, never advances
// the rotation, never consumes a picker override.
const UPPER_ACTIVATION = { title:'Shoulder Prep', cue:'Thirty seconds. Wake the rotators before they carry load.', movements:[
  { name:'External Rotation Sweep', detail:'Elbows pinned to the ribs, forearms sweep out and back — 10 slow reps. Band or light DB if in reach; empty-handed with deliberate tension works.' },
  { name:'Scap Set', detail:'Arms overhead, shrug up, then pull the shoulder blades down and wide. 5 reps. Shoulders packed before the first pull.' }
]};

window.SESSION_TEMPLATES = {
  RP: { name:'Heavy Rings: Pull', fullName:'Heavy Rings A — Pull', grip:'high', activation: UPPER_ACTIVATION, blocks:[
    { type:'anchor', label:'Pull Anchor', core:true, gate:true, progressionType:'heavyAnchor', exercises:['ring-pullup'] },
    { type:'builder', label:'Builders', exercises:['ring-row','ring-pushup'] },
    { type:'finisher', label:'Finisher', exercises:['ring-support'] }
  ]},
  LP: { name:'Lower: Posterior', fullName:'Lower — Posterior + Unilateral', grip:'low', blocks:[
    { type:'finisher', label:'Ring Opener', core:true, exercises:['ring-support'] },
    { type:'anchor', label:'Anchor', core:true, gate:true, exercises:['split-squat'] },
    { type:'builder', label:'Builders', exercises:['single-leg-rdl','jump-rope'] },
    { type:'finisher', label:'Finisher', exercises:['ab-wheel'] }
  ]},
  RPush: { name:'Heavy Rings: Push', fullName:'Heavy Rings B — Push', grip:'high', activation: UPPER_ACTIVATION, blocks:[
    { type:'anchor', label:'Push Anchor', core:true, gate:true, progressionType:'heavyAnchor', exercises:['ring-pushup'] },
    { type:'builder', label:'Builders', exercises:['pike-pushup','ring-pullup'] },
    { type:'finisher', label:'Finisher', exercises:['hollow-body'] }
  ]},
  LS: { name:'Lower: Squat + Cond', fullName:'Lower — Squat + Conditioning', grip:'low', blocks:[
    { type:'finisher', label:'Ring Opener', core:true, exercises:['ring-support'] },
    { type:'anchor', label:'Anchor', core:true, gate:true, exercises:['cossack-squat'] },
    { type:'builder', label:'Builders', exercises:['step-lunge','calf-raise'] },
    { type:'finisher', label:'Conditioning', exercises:['jump-rope'] }
  ]},
  RPr: { name:'Ring Practice + WB', fullName:'Ring Practice + Whole-body', grip:'low', blocks:[
    { type:'builder', label:'Ring Practice', core:true, gate:true, exercises:['ring-row','ring-face-pull'] },
    { type:'builder', label:'Whole-body', exercises:['db-press','para-pushup'] },
    { type:'finisher', label:'Core', exercises:['hanging-knee-raise'] }
  ]},
  MVS: { name:'Floor — Minimum Viable', fullName:'Floor — Minimum Viable Session', grip:'none', noForm:true, blocks:[
    { type:'finisher', label:'Floor', core:true, gate:true, exercises:['pushup','reverse-lunge','hollow-body'] }
  ]}
};
