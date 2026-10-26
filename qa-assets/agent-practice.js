const form = document.querySelector('#practiceForm');
const dialog = document.querySelector('#resetDialog');
const status = document.querySelector('#status');
const completed = new Set();
let saved = null;
const expected = { name: 'HEXIGRID-QA', category: 'Practice', quantity: '3', ready: true, notes: 'Keyboard and mouse test only.' };
const read = () => ({ name: form.elements.recordName.value, category: form.elements.category.value, quantity: form.elements.quantity.value, ready: form.elements.ready.checked, notes: form.elements.notes.value });
const matches = record => record && Object.entries(expected).every(([key, value]) => record[key] === value);
function updateProgress() {
  for (const item of document.querySelectorAll('[data-step]')) item.dataset.complete = String(completed.has(item.dataset.step));
  document.querySelector('#progress').textContent = `${completed.size} of 8 steps complete${completed.size === 8 ? ' — practice task finished.' : ''}`;
}
function inspectFields() {
  const record = read();
  for (const [key, value] of Object.entries(expected)) if (record[key] === value) completed.add(key);
  updateProgress();
}
function showSaved() {
  document.querySelector('#savedRecord').hidden = !saved;
  document.querySelector('#emptyRecord').hidden = Boolean(saved);
  const fields = { savedName: saved?.name, savedCategory: saved?.category, savedQuantity: saved?.quantity, savedReady: saved ? saved.ready ? 'Yes' : 'No' : '', savedNotes: saved?.notes };
  for (const [id, value] of Object.entries(fields)) document.getElementById(id).textContent = value || '';
}
form.addEventListener('input', inspectFields);
form.addEventListener('change', inspectFields);
form.addEventListener('submit', event => {
  event.preventDefault();
  saved = read();
  inspectFields();
  if (matches(saved)) completed.add('save');
  showSaved(); updateProgress();
  status.textContent = matches(saved) ? 'Practice record saved. All five values match the task.' : 'Record saved. Compare its values with the task.';
});
document.querySelector('#resetRecord').addEventListener('click', () => dialog.showModal());
function cancelReset() {
  if (matches(saved)) completed.add('cancel');
  dialog.close(); updateProgress();
  status.textContent = 'Reset canceled. Your practice record is unchanged.';
  document.querySelector('#resetRecord').focus();
}
document.querySelector('#cancelReset').addEventListener('click', cancelReset);
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelReset(); });
document.querySelector('#confirmReset').addEventListener('click', () => {
  if (matches(saved) && completed.has('cancel')) completed.add('reset');
  form.reset(); saved = null;
  showSaved(); updateProgress(); dialog.close();
  status.textContent = 'Practice record cleared. Reload this page to start a new test.';
  form.elements.recordName.focus();
});
