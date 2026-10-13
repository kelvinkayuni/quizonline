import assert from 'node:assert/strict';
import test from 'node:test';
import { assignUniqueStudentQuestionOrders } from '../studentQuestionOrders.js';

function visibleOrders(assignments, usernames, visibleQuestionCount) {
  return usernames.map(username => assignments[username].questionIds.slice(0, visibleQuestionCount));
}

test('assigns two students different orders for a two-question quiz', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }];
  const usernames = ['4550', '4551'];
  const assignments = assignUniqueStudentQuestionOrders(questions, usernames, 2, 'quiz-a');
  const orders = visibleOrders(assignments, usernames, 2);

  assert.equal(new Set(orders.map(order => JSON.stringify(order))).size, usernames.length);
  for (const order of orders) assert.deepEqual([...order].sort(), ['q1', 'q2']);
});

test('assigns three students different orders for a three-question quiz', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
  const usernames = ['4550', '4551', '4552'];
  const assignments = assignUniqueStudentQuestionOrders(questions, usernames, 3, 'quiz-b');
  const orders = visibleOrders(assignments, usernames, 3);

  assert.equal(new Set(orders.map(order => JSON.stringify(order))).size, usernames.length);
});

test('keeps student-visible prefixes unique when only part of the bank is used', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
  const usernames = ['4550', '4551', '4552'];
  const assignments = assignUniqueStudentQuestionOrders(questions, usernames, 2, 'quiz-c');
  const orders = visibleOrders(assignments, usernames, 2);

  assert.equal(new Set(orders.map(order => JSON.stringify(order))).size, usernames.length);
});

test('balances unavoidable repeats when the roster exceeds the available orders', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }];
  const usernames = ['4550', '4551', '4552'];
  const assignments = assignUniqueStudentQuestionOrders(questions, usernames, 2, 'quiz-d');
  const orders = visibleOrders(assignments, usernames, 2);
  const counts = [...orders.reduce((frequency, order) => {
    const key = JSON.stringify(order);
    frequency.set(key, (frequency.get(key) || 0) + 1);
    return frequency;
  }, new Map()).values()].sort((left, right) => left - right);

  assert.deepEqual(counts, [1, 2]);
});

test('distributes excess students as evenly as possible across all orders', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
  const usernames = Array.from({ length: 13 }, (_, index) => `student-${index}`);
  const assignments = assignUniqueStudentQuestionOrders(questions, usernames, 3, 'quiz-e');
  const counts = [...visibleOrders(assignments, usernames, 3).reduce((frequency, order) => {
    const key = JSON.stringify(order);
    frequency.set(key, (frequency.get(key) || 0) + 1);
    return frequency;
  }, new Map()).values()].sort((left, right) => left - right);

  assert.deepEqual(counts, [2, 2, 2, 2, 2, 3]);
});
