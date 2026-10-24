//! A single-threaded EventEmitter. Listeners run synchronously inside `emit`, in the order they
//! were added, over a snapshot of the list (as Node does), so a listener may add or remove
//! listeners while an event is being delivered.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

type Listener<E> = Rc<dyn Fn(&E)>;

pub struct Emitter<E> {
    next: Cell<u64>,
    list: RefCell<Vec<(u64, Listener<E>)>>,
}

impl<E> Default for Emitter<E> {
    fn default() -> Self {
        Emitter { next: Cell::new(1), list: RefCell::new(Vec::new()) }
    }
}

impl<E> Emitter<E> {
    pub fn on(&self, f: impl Fn(&E) + 'static) -> u64 {
        let id = self.next.get();
        self.next.set(id + 1);
        self.list.borrow_mut().push((id, Rc::new(f)));
        id
    }

    pub fn off(&self, id: u64) {
        self.list.borrow_mut().retain(|(x, _)| *x != id);
    }

    pub fn emit(&self, e: E) {
        let snapshot: Vec<Listener<E>> = self.list.borrow().iter().map(|(_, f)| f.clone()).collect();
        for f in snapshot {
            f(&e);
        }
    }
}
