import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSquareAppointmentModel } from '../lib/zenbooker-square-mapper.mjs';

function selection(fieldName, label, quantity = 1) {
  return {
    fieldName,
    label,
    quantity,
    rawLabel: quantity > 1 ? `${quantity} x ${label}` : label,
  };
}

function field(fieldName, labels) {
  return {
    fieldName,
    selections: labels.map((value) => (
      Array.isArray(value)
        ? selection(fieldName, value[0], value[1])
        : selection(fieldName, value)
    )),
  };
}

test('one standard TV creates only a TV segment and keeps cord concealment in the note', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['75 Inches']),
      field('Cord Concealment', ['In-Wall Concealing (Drywall)']),
    ],
    optionSelections: [
      selection('TV Size', '75 Inches'),
      selection('Cord Concealment', 'In-Wall Concealing (Drywall)'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'LJGOOVS5KIIJR7M2I7PDR5RP',
  ]);
  assert.equal(model.segmentItems[0].segmentType, 'base_service');
  assert.match(model.note, /TV sizes: 75 Inches/);
  assert.match(model.note, /Cord Concealment: In-Wall Concealing \(Drywall\)/);
});

test('multi-TV job keeps bracket items separate and unpaired', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['65 Inches', '86 Inches']),
      field('TV Mounting Bracket', ['Fixed Bracket', 'Full Motion']),
    ],
    optionSelections: [
      selection('TV Size', '65 Inches'),
      selection('TV Size', '86 Inches'),
      selection('TV Mounting Bracket', 'Fixed Bracket'),
      selection('TV Mounting Bracket', 'Full Motion'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'OEIUGPSC7KNJZ7J6CC77CR5V',
    '6XN6FG6NZHIGRB37O4536UP7',
    'XXW6UNO5ELUXQ7TVHJJFPGAR',
    'OCWEQ2XTRFFJPC2YEQJULAPW',
  ]);
  assert.deepEqual(model.segmentItems.map((item) => item.segmentType), [
    'base_service',
    'base_service',
    'bracket',
    'bracket',
  ]);
  assert.doesNotMatch(model.note, /TV 1.*Fixed/);
  assert.match(model.note, /Brackets: Fixed Bracket; Full Motion/);
});

test('single fireplace TV uses the fireplace base segment', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['85 Inches']),
      field('Fireplace', ['Above a fireplace']),
    ],
    optionSelections: [
      selection('TV Size', '85 Inches'),
      selection('Fireplace', 'Above a fireplace'),
    ],
    rawNotes: '',
  });

  assert.equal(model.segmentItems[0].catalog_object_id, 'ANA56W25SMZYAW6AFYMXK5PK');
  assert.match(model.segmentItems[0].label, /over fireplace/i);
  assert.deepEqual(model.warnings, []);
});

test('single over-fireplace wording uses the fireplace base segment', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['75 Inches']),
      field('Fireplace', ['Over Fireplace']),
    ],
    optionSelections: [
      selection('TV Size', '75 Inches'),
      selection('Fireplace', 'Over Fireplace'),
    ],
    rawNotes: '',
  });

  assert.equal(model.segmentItems[0].catalog_object_id, 'PUK5RW55CEN7UEKR4RGHDKFV');
  assert.deepEqual(model.warnings, []);
});

test('multi-TV fireplace answers map by index when every TV has an answer', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['55 Inches', '65 Inches']),
      field('Fireplace', ['Above a fireplace', 'Not going above a fireplace']),
    ],
    optionSelections: [
      selection('TV Size', '55 Inches'),
      selection('TV Size', '65 Inches'),
      selection('Fireplace', 'Above a fireplace'),
      selection('Fireplace', 'Not going above a fireplace'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'WXFH7HSFOVKECZ2JMJD3GP3W',
    'OEIUGPSC7KNJZ7J6CC77CR5V',
  ]);
  assert.deepEqual(model.warnings, []);
});

test('ambiguous multi-TV fireplace stays standard and writes a warning note', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['55 Inches', '65 Inches']),
      field('Fireplace', ['Above a fireplace']),
    ],
    optionSelections: [
      selection('TV Size', '55 Inches'),
      selection('TV Size', '65 Inches'),
      selection('Fireplace', 'Above a fireplace'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.slice(0, 2).map((item) => item.catalog_object_id), [
    'S4IRWJGHYNKWFQNPIKIWAH5B',
    'OEIUGPSC7KNJZ7J6CC77CR5V',
  ]);
  assert.match(model.note, /Ambiguous fireplace selection: Above a fireplace/);
  assert.deepEqual(model.warnings, ['ambiguous_fireplace_selection']);
});

test('non-standard base TV services still create the base appointment segment', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Picture Frame (Gallery) Style TVs (Samsung Frame, LG G Series, Hisense Canvas, TCL NXTFRAME...)',
    fieldSelections: [
      field('TV Size', ['65 Inches']),
      field('Wall Surface', ['Brick']),
    ],
    optionSelections: [
      selection('TV Size', '65 Inches'),
      selection('Wall Surface', 'Brick'),
    ],
    rawNotes: 'Customer has Samsung Frame mount kit.',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'J34PODCQBCZ6Y32A6OKSSBNO',
  ]);
  assert.match(model.note, /ZenBooker notes: Customer has Samsung Frame mount kit\./);
  assert.match(model.note, /Surface: Brick/);
});

test('unmount add-ons are note-only when attached to a TV mounting service', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['65 Inches']),
      field('Unmount', ['Unmount 65" Or Under TV']),
    ],
    optionSelections: [
      selection('TV Size', '65 Inches'),
      selection('Unmount', 'Unmount 65" Or Under TV'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'OEIUGPSC7KNJZ7J6CC77CR5V',
  ]);
  assert.match(model.note, /Unmount: Unmount 65" Or Under TV/);
});

test('unmapped bracket selections stay in the note and create a warning', () => {
  const model = buildSquareAppointmentModel({
    serviceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    fieldSelections: [
      field('TV Size', ['65 Inches']),
      field('TV Mounting Bracket', ['Special Customer Bracket']),
    ],
    optionSelections: [
      selection('TV Size', '65 Inches'),
      selection('TV Mounting Bracket', 'Special Customer Bracket'),
    ],
    rawNotes: '',
  });

  assert.deepEqual(model.segmentItems.map((item) => item.catalog_object_id), [
    'OEIUGPSC7KNJZ7J6CC77CR5V',
  ]);
  assert.match(model.note, /Brackets: Special Customer Bracket/);
  assert.deepEqual(model.warnings, ['unknown_options']);
  assert.deepEqual(model.unknownOptions, ['Special Customer Bracket']);
});
