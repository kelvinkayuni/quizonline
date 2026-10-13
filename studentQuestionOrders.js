const UINT32_RANGE = 0x100000000;

function randomIndex(maxExclusive) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random order generation is unavailable in this browser.');
  }
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  const values = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maxExclusive;
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = randomIndex(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function uniqueOrderCapacity(questionCount, visibleQuestionCount, minimumCapacity) {
  let capacity = 1;
  for (let index = 0; index < visibleQuestionCount; index++) {
    capacity *= questionCount - index;
    if (capacity >= minimumCapacity) return capacity;
  }
  return capacity;
}

function enumerateVisibleOrders(questions, visibleQuestionCount) {
  const orders = [];
  function appendOrders(remaining, prefix) {
    if (prefix.length === visibleQuestionCount) {
      orders.push([...prefix, ...shuffled(remaining)]);
      return;
    }
    for (const question of shuffled(remaining)) {
      appendOrders(remaining.filter(candidate => candidate !== question), [...prefix, question]);
    }
  }
  appendOrders(questions, []);
  return orders;
}

export function assignUniqueStudentQuestionOrders(questions, usernames, visibleQuestionCount, quizId) {
  const students = [...new Set(usernames.map(username => String(username || '').trim()).filter(Boolean))];
  const questionCount = questions.length;
  const visibleCount = Math.min(questionCount, Math.floor(Number(visibleQuestionCount)));

  if (!quizId) throw new Error('A quiz ID is required to assign question orders.');
  if (!questionCount || !visibleCount) throw new Error('The quiz must contain at least one visible question.');
  if (!students.length) throw new Error('Import student accounts before submitting a quiz with unique question orders.');

  const questionIds = questions.map(question => String(question.id ?? ''));
  if (questionIds.some(id => !id) || new Set(questionIds).size !== questionCount) {
    throw new Error('Every quiz question must have a unique ID before it can be assigned.');
  }

  const capacity = uniqueOrderCapacity(questionCount, visibleCount, students.length);
  const randomizedStudents = shuffled(students);
  if (students.length > capacity) {
    const allOrders = shuffled(enumerateVisibleOrders(questions, visibleCount));
    return Object.fromEntries(randomizedStudents.map((username, index) => [
      username,
      { quizId, questionIds: allOrders[index % allOrders.length].map(question => question.id) }
    ]));
  }

  const usedSequences = new Set();
  const assignments = [];
  for (const username of randomizedStudents) {
    let order;
    let sequenceKey;
    do {
      order = shuffled(questions);
      sequenceKey = JSON.stringify(order.slice(0, visibleCount).map(question => String(question.id)));
    } while (usedSequences.has(sequenceKey));

    usedSequences.add(sequenceKey);
    assignments.push([username, { quizId, questionIds: order.map(question => question.id) }]);
  }

  return Object.fromEntries(assignments);
}
