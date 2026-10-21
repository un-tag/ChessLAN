import { useMemo } from "react";
import { computeRatings, headToHead, ratingsFor, START_RATING, type CategoryRating } from "../../shared/ratings";
import { RATED_CATEGORIES, categoryLabel } from "../../shared/timeControl";
import { myId, opponent, useStore } from "../state/store";
import { recordOutcome } from "./results";

/** Rating history for both players as two lines on one small chart. */
function RatingChart({ series }: { series: { label: string; cls: string; data: CategoryRating["history"] }[] }) {
  const all = series.flatMap((s) => s.data);
  if (all.length < 2) return <div className="chart-empty muted small">Play a few games to see a chart</div>;
  const ratings = all.map((p) => p.rating).concat(START_RATING);
  const lo = Math.min(...ratings) - 10;
  const hi = Math.max(...ratings) + 10;
  const n = Math.max(...series.map((s) => s.data.length));
  const W = 300;
  const H = 90;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (r: number) => H - ((r - lo) / (hi - lo)) * H;
  return (
    <svg className="chart" viewBox={`-4 -4 ${W + 8} ${H + 8}`} role="img" aria-label="Rating history">
      <line x1={0} x2={W} y1={y(START_RATING)} y2={y(START_RATING)} className="chart-base" />
      {series.map((s) => (
        <polyline
          key={s.label}
          className={`chart-line ${s.cls}`}
          points={[START_RATING, ...s.data.map((p) => p.rating)].map((r, i) => `${x(i)},${y(r)}`).join(" ")}
        />
      ))}
    </svg>
  );
}

export function Stats() {
  const records = useStore((s) => s.records);
  const opp = useStore((s) => opponent(s));
  const me = myId();
  const myName = useStore((s) => s.config?.player?.name ?? "You");
  const ratings = useMemo(() => computeRatings(records), [records]);
  const mine = ratingsFor(ratings, me);
  const theirs = opp ? ratingsFor(ratings, opp.id) : null;
  const botGames = records.filter((r) => r.bot && (r.white.id === me || r.black.id === me));
  const botWins = botGames.filter((r) => recordOutcome(r, me) === "win").length;
  const total = opp ? headToHead(records, me, opp.id) : null;

  return (
    <div className="page stats">
      <h2>Stats</h2>
      {opp && total && (
        <section className="card overall">
          <h3>
            {myName} vs {opp.name}
          </h3>
          <ScoreBar wins={total.wins} draws={total.draws} losses={total.losses} />
          <p className="muted small">
            Best winning streak: {total.bestWinStreak}
            {total.streak > 0 && ` · On a ${total.streak}-game winning streak`}
            {total.streak < 0 && ` · ${opp.name} has won the last ${-total.streak}`}
          </p>
        </section>
      )}
      <div className="stats-grid">
        {RATED_CATEGORIES.map((c) => {
          const h = opp ? headToHead(records, me, opp.id, c) : null;
          return (
            <section className="card" key={c}>
              <h3>{categoryLabel(c)}</h3>
              <div className="rating-pair">
                <div>
                  <div className="big-rating mine">{mine[c].rating}</div>
                  <div className="muted small">You · peak {mine[c].peak}</div>
                </div>
                {opp && theirs && (
                  <div>
                    <div className="big-rating theirs">{theirs[c].rating}</div>
                    <div className="muted small">
                      {opp.name} · peak {theirs[c].peak}
                    </div>
                  </div>
                )}
              </div>
              <RatingChart
                series={[
                  { label: "You", cls: "mine", data: mine[c].history },
                  ...(opp && theirs ? [{ label: opp.name, cls: "theirs", data: theirs[c].history }] : []),
                ]}
              />
              {h && <ScoreBar wins={h.wins} draws={h.draws} losses={h.losses} />}
            </section>
          );
        })}
      </div>
      <section className="card">
        <h3>Against the computer</h3>
        <p>
          {botGames.length} games · {botWins} wins
        </p>
      </section>
    </div>
  );
}

function ScoreBar({ wins, draws, losses }: { wins: number; draws: number; losses: number }) {
  const total = wins + draws + losses;
  if (!total) return <p className="muted small">No games yet</p>;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div>
      <div className="score-bar">
        <span className="w" style={{ width: pct(wins) }} />
        <span className="d" style={{ width: pct(draws) }} />
        <span className="l" style={{ width: pct(losses) }} />
      </div>
      <div className="score-legend">
        <span className="up">{wins} won</span>
        <span>{draws} drawn</span>
        <span className="down">{losses} lost</span>
      </div>
    </div>
  );
}
