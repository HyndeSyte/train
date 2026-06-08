"use strict";
// ===================================================================
// data.js  -  static content for Train (loaded before the inline app script).
// Defines window.EXERCISE_LIBRARY, window.FORM, window.SESSION_TEMPLATES.
// No app state or logic here. Keep classic: no defer / async / type=module.
// ===================================================================
window.TRAIN_DATA_VERSION = '6.2';

// ===================================================================
// EXERCISE LIBRARY
// ===================================================================
window.EXERCISE_LIBRARY = {
  'ring-row': { name:'Ring Row', grip:'high', ladder:['Inverted Row (feet down)','Ring Row (feet elevated)','Archer Ring Row','Front Lever Tuck Row'], repRange:[5,8], sets:3, unit:'reps', reference:{ status:'text', cue:'Full range, slow eccentric. Control the bottom. Heel of palm over the ring, not the fingers.', mediaUrl:null, mediaType:null, sourceLabel:null } },
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

  'split-squat': { name:'Bulgarian Split Squat', grip:'none', ladder:['BW Split Squat','Bulgarian Split Squat','DB Bulgarian Split Squat','DB BSS (pause at bottom)'], repRange:[6,10], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Rear foot on a bench or box. Upright torso.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'step-lunge': { name:'Step-Through Lunge', grip:'none', ladder:['Reverse Lunge','Step-Through Lunge','Step-Through + Balance Hold','Step-Through + Hop'], repRange:[6,10], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Balance pause at the top of each rep.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'cossack-squat': { name:'Cossack Squat', grip:'none', ladder:['Supported Cossack Squat','Cossack Squat','Cossack Squat (slow tempo)','Weighted Cossack Squat'], repRange:[5,8], sets:3, unit:'reps/side', reference:{ status:'text', cue:'Lateral plane. Heel stays planted. Go only as deep as you can control.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'calf-raise': { name:'Calf Raises', grip:'none', ladder:['Bilateral Calf Raise','Slow Bilateral (3s up/3s down)','Single-Leg Calf Raise','Single-Leg Slow Calf Raise'], repRange:[12,20], sets:2, unit:'reps', reference:{ status:'text', cue:'Full ROM. Pause at the top and bottom.', mediaUrl:null, mediaType:null, sourceLabel:null } },
  'hollow-body': { name:'Hollow Body Hold', grip:'none', ladder:['Tuck Hollow Hold','Single-Leg Hollow Hold','Hollow Body Hold','Hollow Body Rock'], repRange:[20,40], sets:3, unit:'sec', reference:{ status:'text', cue:'Lower back glued to the floor. Breathe.', mediaUrl:null, mediaType:null, sourceLabel:null } }
};

// ===================================================================
// THE FORM  (fixed universal mobility kata — 7 in-app screens)
// blockType: form / stepType: guided. NOT logged as sets.
// ===================================================================
window.FORM = {
  name: 'Form',
  screens: [
    { id:'f1', title:'Root &amp; Prepare', cue:'Begin standing. Feet planted, hands rise from the sides.', movements:[
      { name:'Root + Breath + Weight Shift', detail:'Grounded stance, toes spread, weight through the foot tripod \u2014 big-toe mound, little-toe mound, heel. Knees soft and tracking over the toes, pelvis quiet, ribs down, crown tall. Three slow breaths. Shift weight slowly between the feet, slow enough that balance is never stolen.' },
      { name:'Wrist + Hand Wave \u2192 Centerline', detail:'Wrist circles, palm flex and extend, finger articulation. Finish with the hands drawn to the centerline near the sternum, elbows heavy, shoulders quiet.' },
      { name:'Neck + Scapular Setting', detail:'Small controlled circles. Collarbones wide, traps quiet. Set the shoulders before anything goes overhead.' }
    ]},
    { id:'f2', title:'Spinal Wave', cue:'Stay tall. Let the reach grow out of quiet shoulders.', movements:[
      { name:'Spinal Wave', detail:'Overhead reach, lateral lean, rotation through the torso. Five each direction. Full spinal length without forcing.' }
    ]},
    { id:'f3', title:'Low Lunge + Reach', cue:'Step one foot back slowly; descend with the exhale.', movements:[
      { name:'Low Lunge + Reach', detail:'Step one foot back into a low lunge. Sink the hips, reach the same-side arm overhead, lengthen through the front of the trailing hip. Three to five per side. The bridge from standing to the floor.' }
    ]},
    { id:'f4', title:'Deep Squat Pry', cue:'Bring the front foot in to meet the other; sink into the bottom.', movements:[
      { name:'Deep Squat Pry', detail:'Feet wide, sink to the bottom, elbows gently push the knees out. Explore and shift within the position. Thirty to forty-five seconds. A moving conversation with the bottom range.' }
    ]},
    { id:'f5', title:'90/90 Flow', cue:'Lower the seat to the floor; roll through one side, do not collapse back.', movements:[
      { name:'90/90 Flow', detail:'Seated, dynamic transitions between internal and external rotation, tall spine. Five each direction. Active, not passive.' }
    ]},
    { id:'f6', title:'Hollow \u2194 Arch', cue:'Settle onto the back; organize hollow before adding tension.', movements:[
      { name:'Hollow \u2194 Arch Tension', detail:'On the back, organize hollow \u2014 posterior tilt, ribs down, everything engaged. Flip prone into arch, full-body extension tension. Three to five deliberate transitions. The internal engine: controlled total-body tension, no wasted movement.' }
    ]},
    { id:'f7', title:'Bow &amp; Close', cue:'Press to hands and knees, rise slowly, then stack up into the bow.', movements:[
      { name:'Jefferson Curl / Bow', detail:'Standing, fold vertebra by vertebra, head heavy, slow return. Five reps. Unloaded and breath-led \u2014 a bow into the work, not a hamstring stretch.' },
      { name:'Closing Reach + Breath', detail:'Full overhead reach, pause, slow exhale as the arms lower. Three reps. The seal \u2014 it marks completion.' }
    ]}
  ]
};

// ===================================================================
// SESSION TEMPLATES (working blocks; the Form replaces the old mobility primer)
// ===================================================================
window.SESSION_TEMPLATES = {
  RP: { name:'Heavy Rings: Pull', fullName:'Heavy Rings A \u2014 Pull', grip:'high', blocks:[
    { type:'anchor', label:'Pull Anchor', progressionType:'heavyAnchor', exercises:['ring-pullup'] },
    { type:'builder', label:'Builders', exercises:['ring-row','ring-pushup'] },
    { type:'finisher', label:'Finisher', exercises:['ring-support'] }
  ]},
  LP: { name:'Lower: Posterior', fullName:'Lower \u2014 Posterior + Unilateral', grip:'low', blocks:[
    { type:'finisher', label:'Ring Opener', exercises:['ring-support'] },
    { type:'anchor', label:'Anchor', exercises:['split-squat'] },
    { type:'builder', label:'Builders', exercises:['single-leg-rdl','jump-rope'] },
    { type:'finisher', label:'Finisher', exercises:['ab-wheel'] }
  ]},
  RPush: { name:'Heavy Rings: Push', fullName:'Heavy Rings B \u2014 Push', grip:'high', blocks:[
    { type:'anchor', label:'Push Anchor', progressionType:'heavyAnchor', exercises:['ring-pushup'] },
    { type:'builder', label:'Builders', exercises:['pike-pushup','ring-pullup'] },
    { type:'finisher', label:'Finisher', exercises:['hollow-body'] }
  ]},
  LS: { name:'Lower: Squat + Cond', fullName:'Lower \u2014 Squat + Conditioning', grip:'low', blocks:[
    { type:'finisher', label:'Ring Opener', exercises:['ring-support'] },
    { type:'anchor', label:'Anchor', exercises:['cossack-squat'] },
    { type:'builder', label:'Builders', exercises:['step-lunge','calf-raise'] },
    { type:'finisher', label:'Conditioning', exercises:['jump-rope'] }
  ]},
  RPr: { name:'Ring Practice + WB', fullName:'Ring Practice + Whole-body', grip:'low', blocks:[
    { type:'builder', label:'Ring Practice', exercises:['ring-row','ring-face-pull'] },
    { type:'builder', label:'Whole-body', exercises:['db-press','para-pushup'] },
    { type:'finisher', label:'Core', exercises:['hanging-knee-raise'] }
  ]}
};
