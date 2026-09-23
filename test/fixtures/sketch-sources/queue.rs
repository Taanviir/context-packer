use std::collections::VecDeque;

/** A bounded FIFO queue. */
pub struct Queue<T> {
    items: VecDeque<T>,
    capacity: usize,
}

/** Errors a queue can return. */
pub enum QueueError {
    Full,
    Empty,
}

pub trait Drain {
    fn drain_all(&mut self) -> usize;
}

impl<T> Queue<T> {
    /** Creates an empty queue. */
    pub fn new(capacity: usize) -> Self {
        Queue { items: VecDeque::new(), capacity }
    }

    pub fn push(&mut self, item: T) -> Result<(), QueueError> {
        if self.items.len() >= self.capacity { return Err(QueueError::Full); }
        self.items.push_back(item);
        Ok(())
    }
}
