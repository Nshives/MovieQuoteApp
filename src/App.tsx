import { useState, useEffect, useRef } from 'react'
import movieQuotesData from './assets/movieQuotes.json'

interface Quote {
  quote: string;
  movie: string;
  imdbId?: string;
}

type Difficulty = 'easy' | 'medium' | 'hard';

const QUESTIONS_PER_GAME = 10;
const OPTIONS_COUNT: Record<Difficulty, number> = { easy: 4, medium: 6, hard: 8 };

// Deterministic seeded random using a simple mulberry32 PRNG.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateToSeed(dateStr: string): number {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (Math.imul(31, hash) + dateStr.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getToday(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

// Filter out quotes where the quote text contains the movie title (case-insensitive).
const allQuotes: Quote[] = movieQuotesData.quotes.filter(q => {
  const movieWords = q.movie
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(w => w.length > 3);
  const quoteText = q.quote.toLowerCase();
  return !movieWords.some(word => quoteText.includes(word));
});

// Build today's game: 10 quotes seeded by date, no two from the same movie.
function buildDailyGame(today: string): Quote[] {
  const rand = mulberry32(dateToSeed(today));

  // Shuffle all quotes with the seeded RNG.
  const shuffled = [...allQuotes].sort(() => rand() - 0.5);

  const selected: Quote[] = [];
  const usedMovies = new Set<string>();

  for (const q of shuffled) {
    if (!usedMovies.has(q.movie)) {
      selected.push(q);
      usedMovies.add(q.movie);
      if (selected.length === QUESTIONS_PER_GAME) break;
    }
  }
  return selected;
}

// Build wrong options for a given question, seeded so they're consistent within a session.
function buildOptions(correct: Quote, allPool: Quote[], count: number, rand: () => number): Quote[] {
  const pool = allPool
    .filter(q => q.movie !== correct.movie)
    .sort(() => rand() - 0.5);

  // Deduplicate by movie.
  const seen = new Set<string>();
  const distractors: Quote[] = [];
  for (const q of pool) {
    if (!seen.has(q.movie)) {
      seen.add(q.movie);
      distractors.push(q);
      if (distractors.length === count - 1) break;
    }
  }

  return [correct, ...distractors].sort(() => rand() - 0.5);
}

const STORAGE = {
  lastGameDate: 'lastGameDate',
  questionNumber: 'questionNumber',
  score: 'score',
  answers: 'answers',      // JSON array of booleans
  difficulty: 'difficulty',
  streak: 'streak',
  lastPlayDate: 'lastPlayDate',
  scoreHistory: 'scoreHistory',
};

function loadStorage<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? JSON.parse(val) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const today = getToday();
  const dailyQuotes = useRef<Quote[]>(buildDailyGame(today));

  // Session state — restored from localStorage whenever today's game has been started.
  const savedDate = loadStorage<string>(STORAGE.lastGameDate, '');
  const playedToday = savedDate === today;
  const savedQuestionNumber = loadStorage<number>(STORAGE.questionNumber, 0);
  const gameInProgress = playedToday && savedQuestionNumber < QUESTIONS_PER_GAME;
  const gameComplete = playedToday && savedQuestionNumber >= QUESTIONS_PER_GAME;

  const [questionIndex, setQuestionIndex] = useState<number>(() =>
    playedToday ? Math.min(savedQuestionNumber, QUESTIONS_PER_GAME - 1) : 0
  );
  const [score, setScore] = useState<number>(() =>
    playedToday ? loadStorage<number>(STORAGE.score, 0) : 0
  );
  const [answers, setAnswers] = useState<boolean[]>(() =>
    playedToday ? loadStorage<boolean[]>(STORAGE.answers, []) : []
  );
  const [difficulty, setDifficulty] = useState<Difficulty>(() =>
    loadStorage<Difficulty>(STORAGE.difficulty, 'easy')
  );
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [showScorePopup, setShowScorePopup] = useState(gameComplete);
  const [showMoviesPopup, setShowMoviesPopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isDone, setIsDone] = useState(gameComplete);

  const [streak, setStreak] = useState<number>(() => {
    const saved = loadStorage<number>(STORAGE.streak, 0);
    const lastPlay = loadStorage<string>(STORAGE.lastPlayDate, '');
    if (!lastPlay) return 0;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toLocaleDateString('en-CA');
    if (lastPlay === yStr || lastPlay === today) return saved;
    return 0;
  });

  const [scoreHistory, setScoreHistory] = useState<number[]>(() =>
    loadStorage<number[]>(STORAGE.scoreHistory, [])
  );

  // Options for the current question — stable within a session.
  const optionsRef = useRef<Quote[][]>([]);
  if (optionsRef.current.length === 0) {
    const rand = mulberry32(dateToSeed(today + difficulty));
    optionsRef.current = dailyQuotes.current.map(q =>
      buildOptions(q, allQuotes, OPTIONS_COUNT[difficulty], rand)
    );
  }

  // When difficulty changes, rebuild options and restart.
  const handleDifficultyChange = (d: Difficulty) => {
    if (isDone) return;
    setDifficulty(d);
    localStorage.setItem(STORAGE.difficulty, JSON.stringify(d));
    const rand = mulberry32(dateToSeed(today + d));
    optionsRef.current = dailyQuotes.current.map(q =>
      buildOptions(q, allQuotes, OPTIONS_COUNT[d], rand)
    );
    // Only reset if game hasn't started.
    if (questionIndex === 0 && answers.length === 0) return;
  };

  const currentQuote = dailyQuotes.current[questionIndex];
  const currentOptions = optionsRef.current[questionIndex] ?? [];

  const handleAnswer = (movie: string) => {
    if (selectedAnswer !== null) return;
    const correct = movie === currentQuote.movie;
    setSelectedAnswer(movie);
    const newScore = correct ? score + 1 : score;
    const newAnswers = [...answers, correct];
    if (correct) setScore(newScore);
    setAnswers(newAnswers);
    localStorage.setItem(STORAGE.score, JSON.stringify(newScore));
    localStorage.setItem(STORAGE.answers, JSON.stringify(newAnswers));
    localStorage.setItem(STORAGE.lastGameDate, JSON.stringify(today));
  };

  const handleNext = () => {
    const nextIndex = questionIndex + 1;
    if (nextIndex < QUESTIONS_PER_GAME) {
      setQuestionIndex(nextIndex);
      setSelectedAnswer(null);
      localStorage.setItem(STORAGE.questionNumber, JSON.stringify(nextIndex));
    } else {
      // Game over.
      const lastPlay = loadStorage<string>(STORAGE.lastPlayDate, '');
      if (lastPlay !== today) {
        const newStreak = streak + 1;
        setStreak(newStreak);
        localStorage.setItem(STORAGE.streak, JSON.stringify(newStreak));
        localStorage.setItem(STORAGE.lastPlayDate, JSON.stringify(today));
      }
      localStorage.setItem(STORAGE.questionNumber, JSON.stringify(QUESTIONS_PER_GAME));

      const newHistory = [...scoreHistory, score];
      setScoreHistory(newHistory);
      localStorage.setItem(STORAGE.scoreHistory, JSON.stringify(newHistory));

      setIsDone(true);
      setShowScorePopup(true);
    }
  };

  const buildShareText = () => {
    const emojis = answers.map(a => (a ? '🟩' : '🟥')).join('');
    return `🎬 CineQuote ${today}\n${score}/${QUESTIONS_PER_GAME} (${difficulty})\n${emojis}\nPlay at: cinequote.app`;
  };

  const handleShare = async () => {
    const text = buildShareText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select a textarea
    }
  };

  const optionColor = (option: Quote) => {
    if (selectedAnswer === null) return 'rgba(255,255,255,0.08)';
    if (option.movie === currentQuote.movie) return '#16a34a'; // green
    if (option.movie === selectedAnswer) return '#dc2626'; // red
    return 'rgba(255,255,255,0.05)';
  };

  const difficultyLabels: Record<Difficulty, string> = {
    easy: `Easy (${OPTIONS_COUNT.easy} options)`,
    medium: `Medium (${OPTIONS_COUNT.medium} options)`,
    hard: `Hard (${OPTIONS_COUNT.hard} options)`,
  };

  const totalGames = scoreHistory.length;
  const avgScore = totalGames > 0
    ? (scoreHistory.reduce((a, b) => a + b, 0) / totalGames).toFixed(1)
    : '—';
  const bestScore = totalGames > 0 ? Math.max(...scoreHistory) : '—';

  return (
    <div className="min-h-screen flex flex-col">
      <div className="w-full max-w-xl mx-auto px-4 py-6 sm:py-8 flex flex-col flex-1">

        {/* Header */}
        <div className="flex items-start justify-between mb-7">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xl">🎬</span>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">
                CineQuote
              </h1>
            </div>
            <p className="text-white/35 text-xs pl-8">{today}</p>
          </div>
          <div className="flex items-center gap-2 text-sm pt-1">
            {streak > 0 && (
              <span className="bg-orange-500/15 text-orange-300 border border-orange-500/25 px-2.5 py-1 rounded-full text-xs font-medium">
                🔥 {streak}
              </span>
            )}
            {!isDone && (
              <select
                value={difficulty}
                onChange={e => handleDifficultyChange(e.target.value as Difficulty)}
                disabled={answers.length > 0}
                className="bg-white/8 border border-white/15 rounded-lg px-2.5 py-1.5 text-white/80 text-xs disabled:opacity-40 cursor-pointer focus:outline-none focus:border-white/30"
              >
                {(Object.keys(difficultyLabels) as Difficulty[]).map(d => (
                  <option key={d} value={d} className="bg-gray-900">{difficultyLabels[d]}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Progress */}
        {!isDone && (
          <div className="mb-5">
            <div className="flex justify-between text-xs text-white/35 mb-1.5">
              <span>Question {questionIndex + 1} / {QUESTIONS_PER_GAME}</span>
              <span>{score} correct</span>
            </div>
            {/* Answer trail dots */}
            <div className="flex gap-1">
              {Array.from({ length: QUESTIONS_PER_GAME }).map((_, i) => (
                <div
                  key={i}
                  className="flex-1 h-1.5 rounded-full transition-colors duration-300"
                  style={{
                    backgroundColor:
                      i < answers.length
                        ? answers[i] ? '#22c55e' : '#ef4444'
                        : i === questionIndex
                        ? 'rgba(255,255,255,0.35)'
                        : 'rgba(255,255,255,0.1)',
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Game over state */}
        {isDone && !showScorePopup && !showMoviesPopup && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
            <div className="text-4xl mb-1">🎉</div>
            <p className="text-white/50 text-sm">You've completed today's game</p>
            <p className="text-2xl font-bold">{score}<span className="text-white/40 font-normal text-lg">/{QUESTIONS_PER_GAME}</span></p>
            <div className="flex gap-3 mt-1">
              <button onClick={() => setShowScorePopup(true)} className="bg-blue-600 hover:bg-blue-500 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
                Results
              </button>
              <button onClick={() => setShowMoviesPopup(true)} className="bg-white/10 hover:bg-white/15 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
                See Movies
              </button>
            </div>
          </div>
        )}

        {/* Active question */}
        {!isDone && currentQuote && (
          <div className="flex-1 flex flex-col">
            {/* Quote card */}
            <div className="relative mb-5 flex-shrink-0">
              <div className="absolute -top-3 -left-1 text-5xl text-white/10 font-serif leading-none select-none">&ldquo;</div>
              <div className="bg-white/[0.04] border border-white/10 rounded-2xl px-6 pt-7 pb-6 shadow-lg">
                <p className="text-lg sm:text-xl italic leading-relaxed text-center text-white/90">
                  {currentQuote.quote}
                </p>
              </div>
              <div className="absolute -bottom-4 -right-1 text-5xl text-white/10 font-serif leading-none select-none rotate-180">&ldquo;</div>
            </div>

            {/* Answer buttons */}
            <div className="grid grid-cols-2 gap-2.5 mb-5 mt-2">
              {currentOptions.map(option => (
                <button
                  key={option.movie}
                  onClick={() => handleAnswer(option.movie)}
                  disabled={selectedAnswer !== null}
                  style={{ backgroundColor: optionColor(option) }}
                  className="text-left px-4 py-3 sm:py-3.5 rounded-xl border border-white/10 text-sm font-medium transition-all duration-200 hover:enabled:bg-white/12 hover:enabled:border-white/20 disabled:cursor-default leading-snug"
                >
                  {option.movie}
                </button>
              ))}
            </div>

            {/* Feedback + next */}
            {selectedAnswer !== null && (
              <div className="text-center">
                <p className={`text-sm mb-3 font-medium ${selectedAnswer === currentQuote.movie ? 'text-green-400' : 'text-red-400'}`}>
                  {selectedAnswer === currentQuote.movie
                    ? '✓ Correct!'
                    : `✗ "${currentQuote.movie}"`}
                </p>
                <button
                  onClick={handleNext}
                  className="bg-blue-600 hover:bg-blue-500 px-8 py-2.5 rounded-xl font-medium text-sm transition-colors"
                >
                  {questionIndex < QUESTIONS_PER_GAME - 1 ? 'Next →' : 'See Results'}
                </button>
              </div>
            )}
          </div>
        )}

      {/* Score popup */}
      {showScorePopup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 max-w-sm w-full relative">
            <button
              onClick={() => setShowScorePopup(false)}
              className="absolute top-4 right-4 text-white/40 hover:text-white text-xl leading-none"
            >
              ×
            </button>

            <h2 className="text-2xl font-bold mb-1">Game Complete!</h2>
            <p className="text-white/50 text-sm mb-4">{today} · {difficultyLabels[difficulty]}</p>

            {/* Big score */}
            <div className="text-center mb-5">
              <span className="text-6xl font-bold">{score}</span>
              <span className="text-2xl text-white/40">/{QUESTIONS_PER_GAME}</span>
            </div>

            {/* Answer trail */}
            <div className="flex gap-1.5 justify-center mb-5">
              {answers.map((a, i) => (
                <div
                  key={i}
                  className={`w-7 h-7 rounded flex items-center justify-center text-xs font-bold ${a ? 'bg-green-600' : 'bg-red-700'}`}
                >
                  {a ? '✓' : '✗'}
                </div>
              ))}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3 mb-5 text-center">
              <div className="bg-white/5 rounded-xl p-3">
                <div className="text-xl font-bold">{streak}</div>
                <div className="text-xs text-white/40 mt-0.5">Streak</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3">
                <div className="text-xl font-bold">{totalGames > 0 ? avgScore : '—'}</div>
                <div className="text-xs text-white/40 mt-0.5">Avg</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3">
                <div className="text-xl font-bold">{totalGames > 0 ? bestScore : '—'}</div>
                <div className="text-xs text-white/40 mt-0.5">Best</div>
              </div>
            </div>

            {/* Score distribution */}
            <div className="mb-5">
              <div className="flex justify-between items-baseline mb-3">
                <h3 className="text-xs text-white/40 uppercase tracking-wider">Score History</h3>
                <span className="text-xs text-white/25">
                  {totalGames === 0 ? 'no games yet' : `${totalGames} game${totalGames === 1 ? '' : 's'}`}
                </span>
              </div>
              {totalGames === 0 ? (
                <p className="text-xs text-white/25 text-center py-3">Play daily to build your history</p>
              ) : (
                (() => {
                  const maxCount = Math.max(
                    ...Array.from({ length: 11 }, (_, n) => scoreHistory.filter(x => x === n).length),
                    1
                  );
                  const scoreColors = [
                    '#ef4444', // 0  — red
                    '#f97316', // 1  — orange-red
                    '#fb923c', // 2  — orange
                    '#f59e0b', // 3  — amber
                    '#eab308', // 4  — yellow
                    '#a3e635', // 5  — yellow-green
                    '#84cc16', // 6  — lime
                    '#22c55e', // 7  — green
                    '#10b981', // 8  — emerald
                    '#14b8a6', // 9  — teal
                    '#06b6d4', // 10 — cyan
                  ];
                  return Array.from({ length: 11 }, (_, i) => 10 - i).map(s => {
                    const count = scoreHistory.filter(x => x === s).length;
                    const isToday = s === score;
                    const barPct = (count / maxCount) * 100;
                    const color = scoreColors[s];
                    return (
                      <div key={s} className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs w-4 text-right font-semibold" style={{ color: isToday ? color : 'rgba(255,255,255,0.35)' }}>{s}</span>
                        <div className="flex-1 bg-white/5 rounded-sm h-5 overflow-hidden relative">
                          <div
                            className="h-full rounded-sm transition-all duration-500"
                            style={{
                              width: count > 0 ? `${Math.max(barPct, 5)}%` : '0%',
                              backgroundColor: isToday ? color : count > 0 ? `${color}55` : 'transparent',
                            }}
                          />
                          {count > 0 && (
                            <span className="absolute right-2 top-0 bottom-0 flex items-center text-xs text-white/50">{count}</span>
                          )}
                        </div>
                        {isToday
                          ? <span className="text-xs font-medium w-8" style={{ color }}>today</span>
                          : <span className="w-8" />}
                      </div>
                    );
                  });
                })()
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleShare}
                className="flex-1 bg-blue-600 hover:bg-blue-500 py-2.5 rounded-xl font-medium transition-colors"
              >
                {copied ? '✓ Copied!' : '🔗 Share'}
              </button>
              <button
                onClick={() => { setShowScorePopup(false); setShowMoviesPopup(true); }}
                className="flex-1 bg-white/10 hover:bg-white/20 py-2.5 rounded-xl font-medium transition-colors"
              >
                See Movies
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Movies popup */}
      {showMoviesPopup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 max-w-sm w-full max-h-[80vh] overflow-y-auto relative">
            <button
              onClick={() => setShowMoviesPopup(false)}
              className="absolute top-4 right-4 text-white/40 hover:text-white text-xl leading-none"
            >
              ×
            </button>
            <h2 className="text-xl font-bold mb-4">Today's Movies</h2>
            <div className="space-y-2">
              {dailyQuotes.current.map((q, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                      answers[i] === true ? 'bg-green-600' : answers[i] === false ? 'bg-red-700' : 'bg-white/10'
                    }`}
                  >
                    {answers[i] === true ? '✓' : answers[i] === false ? '✗' : i + 1}
                  </div>
                  <span className="text-sm flex-1">{q.movie}</span>
                  {q.imdbId && (
                    <a
                      href={`https://www.imdb.com/title/${q.imdbId}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-yellow-400/70 hover:text-yellow-400 font-medium"
                    >
                      IMDb
                    </a>
                  )}
                </div>
              ))}
            </div>
            {isDone && (
              <button
                onClick={() => setShowScorePopup(true)}
                className="w-full mt-4 bg-blue-600 hover:bg-blue-500 py-2.5 rounded-xl font-medium transition-colors"
              >
                Back to Results
              </button>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
