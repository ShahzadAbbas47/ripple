import { useReducer } from 'react';
import { reduce, initialState, OBJECTIVES, PHASE_INFO } from './sim/engine';

export default function App() {
  const [s, dispatch] = useReducer(reduce, undefined, initialState);
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
      <h1>{PHASE_INFO[s.phase].title}</h1>
      <p>{PHASE_INFO[s.phase].goal}</p>

      {s.phase === 'CML1' && Object.values(OBJECTIVES).map(o => (
        <button key={o.id} onClick={() => dispatch({ type: 'SET_OBJECTIVE', id: o.id })}>
          {o.name}
        </button>
      ))}

      {s.blockers.map(b => <p key={b.title} style={{ color: 'crimson' }}>✖ {b.title}: {b.why}</p>)}
      <button onClick={() => dispatch({ type: 'ADVANCE' })}>Next</button>
    </div>
  );
}